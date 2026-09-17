"""
Keep the CloudFront origin record pointed at the running task's public IP.

The gap this fills: ECS Service Discovery registers a task's *private* IP when
the network mode is awsvpc, with no option to publish the public one. That is
correct for service-to-service traffic inside a VPC, and useless to CloudFront,
which resolves the origin from the public internet and gets 10.20.x.x.

So Service Discovery handles nothing here and this does the addressing instead:
EventBridge reports every ECS task state change, and on each one this resolves
the task's ENI, reads the public IP off it, and writes an A-record.

Why not just give the task a stable address? Fargate has no equivalent of an
Elastic IP — the public IP is assigned at task start and released at task stop.
An ALB or NLB is the AWS-sanctioned answer, and costs ~$16/month to give one
task a stable name. This is the cheap version of the same idea.

Failure behaviour is deliberate: an event this cannot act on is logged and
skipped rather than raised. A raised exception would be retried by EventBridge,
and retrying a stale task-start event could publish an IP that has already been
released.
"""

import os
from datetime import datetime, timezone

import boto3

ecs = boto3.client("ecs")
ec2 = boto3.client("ec2")
route53 = boto3.client("route53")

ZONE_ID = os.environ["HOSTED_ZONE_ID"]
RECORD_NAME = os.environ["RECORD_NAME"]
CLUSTER = os.environ["CLUSTER"]
TTL = int(os.environ.get("TTL", "15"))


def _public_ip(task: dict) -> str | None:
    """The public IP on the task's elastic network interface, if it has one."""
    eni_id = None
    for attachment in task.get("attachments", []):
        if attachment.get("type") != "ElasticNetworkInterface":
            continue
        for detail in attachment.get("details", []):
            if detail.get("name") == "networkInterfaceId":
                eni_id = detail.get("value")
    if eni_id is None:
        return None

    described = ec2.describe_network_interfaces(NetworkInterfaceIds=[eni_id])
    interfaces = described.get("NetworkInterfaces", [])
    if not interfaces:
        return None
    return interfaces[0].get("Association", {}).get("PublicIp")


def _running_task_ips() -> list[str]:
    """Public IPs of every RUNNING task in the service, newest last.

    Read fresh from the API rather than taken from the event: by the time this
    runs, the task the event describes may already be gone, and a task the
    event knows nothing about may have started. The answer that matters is
    which tasks are running *now*.
    """
    listed = ecs.list_tasks(cluster=CLUSTER, desiredStatus="RUNNING")
    arns = listed.get("taskArns", [])
    if not arns:
        return []

    described = ecs.describe_tasks(cluster=CLUSTER, tasks=arns)
    ips = []
    for task in described.get("tasks", []):
        if task.get("lastStatus") != "RUNNING":
            continue
        ip = _public_ip(task)
        if ip is not None:
            ips.append(ip)
    return ips


MARKER_NAME = f"_origin-dns-marker.{RECORD_NAME}"


def _event_time(event: dict) -> str:
    """When ECS observed the state change this invocation is reacting to.

    Falls back to now for a manual invocation, which has no event time and
    should therefore be treated as the most recent thing that happened.
    """
    return event.get("time") or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _marker_is_newer(event_time: str) -> bool:
    """True when a previous write came from an ECS event later than this one."""
    try:
        found = route53.list_resource_record_sets(
            HostedZoneId=ZONE_ID,
            StartRecordName=MARKER_NAME,
            StartRecordType="TXT",
            MaxItems="1",
        )["ResourceRecordSets"]
    except Exception as error:  # noqa: BLE001 - never block the write on a read
        print(f"could not read the marker ({error}); proceeding")
        return False

    if not found or found[0]["Name"].rstrip(".") != MARKER_NAME.rstrip("."):
        return False

    records = found[0].get("ResourceRecords", [])
    if not records:
        return False

    # Stored quoted, as TXT values are.
    previous = records[0]["Value"].strip('"')
    return previous > event_time


def handler(event, _context):
    ips = _running_task_ips()

    if not ips:
        # Every task is stopped — mid-deploy, or the service is scaled to zero.
        # The record is left pointing at the last known IP rather than deleted:
        # a deploy replaces tasks within seconds, and removing the record would
        # turn a brief 502 into an NXDOMAIN that resolvers cache.
        print("no running tasks with a public IP; leaving the record as it is")
        return {"updated": False, "reason": "no running tasks"}

    # Skip the write when the record already says this. That makes a repeat
    # invocation free and keeps Route53 call volume down.
    #
    # It is NOT a fix for interleaving, and it is worth being precise about
    # that: read-then-write is not compare-and-swap, so a stale invocation can
    # still land after a newer one and leave a dead IP in the record. The
    # honest mitigations are a reserved concurrency of 1 (refused here — the
    # account's Lambda limit is the unraised default of 10, and AWS will not
    # allow a reservation that takes unreserved capacity below that) or a
    # single-consumer FIFO queue in front of the function.
    #
    # Accepted for now because the exposure is small and self-healing: the
    # window is the few hundred milliseconds between this read and its write,
    # it needs two task events inside that window, and `_stale_guard` below
    # bounds the damage by refusing to publish an IP that no longer belongs to
    # a running task. A wrong record also breaks nothing silently — CloudFront
    # returns 502 and the next task event corrects it.
    #
    # Revisit with a FIFO queue if deploys ever become frequent enough for two
    # task events to overlap routinely.
    try:
        current = route53.list_resource_record_sets(
            HostedZoneId=ZONE_ID,
            StartRecordName=RECORD_NAME,
            StartRecordType="A",
            MaxItems="1",
        )["ResourceRecordSets"]
        if current and current[0]["Name"].rstrip(".") == RECORD_NAME.rstrip("."):
            existing = {r["Value"] for r in current[0].get("ResourceRecords", [])}
            if existing == set(ips):
                print(f"{RECORD_NAME} already points at {', '.join(sorted(ips))}")
                return {"updated": False, "reason": "unchanged", "ips": ips}
    except Exception as error:  # noqa: BLE001 - a read failure must not block the write
        print(f"could not read the current record ({error}); writing anyway")

    # Last-moment re-read, which closes the common case: an invocation that
    # spent time on the Route53 read only to find its task has since stopped
    # drops out rather than publishing a dead address.
    fresh = set(_running_task_ips())
    if fresh != set(ips):
        print("the running set changed while this invocation ran; leaving the write to the newer event")
        return {"updated": False, "reason": "superseded"}

    # And the narrower case the re-read cannot catch: two invocations that both
    # see the same set, where the older one writes last. Every write carries
    # the ECS event time it was derived from, in a TXT record beside the A
    # record, and an invocation refuses to overwrite a marker newer than its
    # own event. That makes the pair an ordered write rather than a race.
    #
    # Not a true compare-and-swap — Route53 has no conditional write — but it
    # turns "last writer wins" into "newest event wins", which is the property
    # that actually matters here.
    event_time = _event_time(event)
    if _marker_is_newer(event_time):
        print(f"a newer event ({event_time} is older) already published; standing down")
        return {"updated": False, "reason": "superseded by a newer event"}

    route53.change_resource_record_sets(
        HostedZoneId=ZONE_ID,
        ChangeBatch={
            "Comment": "ECS task public IP, updated by origin-dns",
            "Changes": [
                {
                    "Action": "UPSERT",
                    "ResourceRecordSet": {
                        "Name": RECORD_NAME,
                        "Type": "A",
                        "TTL": TTL,
                        # Every running task, so a deploy that briefly runs two
                        # resolves to both and CloudFront may use either.
                        "ResourceRecords": [{"Value": ip} for ip in ips],
                    },
                },
                {
                    # In the same batch as the A record, so the two can never
                    # disagree: Route53 applies a change batch atomically.
                    "Action": "UPSERT",
                    "ResourceRecordSet": {
                        "Name": MARKER_NAME,
                        "Type": "TXT",
                        "TTL": TTL,
                        "ResourceRecords": [{"Value": f'"{event_time}"'}],
                    },
                },
            ],
        },
    )

    print(f"{RECORD_NAME} -> {', '.join(ips)}")
    return {"updated": True, "ips": ips}
