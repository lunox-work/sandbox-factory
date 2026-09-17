"""
Keep the CloudFront origin record pointed at the running task's public IP.

Invoked on every ECS task state change. It lists the running tasks, reads each
public IP off its ENI, and writes them to one A record. See infra/discovery.tf
for why neither Service Discovery nor a load balancer does this job.

An event it cannot act on (no running task, superseded by a newer event) is
logged and skipped, not raised: EventBridge retries a raised event, and a
retried stale task-start could publish an IP that has already been released.
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
    """Public IPs of every RUNNING task in the cluster.

    Read from the API, not the event: by the time this runs, the event's task
    may be gone and another may have started.
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
    """When ECS observed the state change.

    A manual invocation has no event time, so it counts as the newest event.
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
        # Mid-deploy, or scaled to zero. The record keeps its last IP rather
        # than being deleted: removing it would turn a brief 502 into an
        # NXDOMAIN that resolvers cache.
        print("no running tasks with a public IP; leaving the record as it is")
        return {"updated": False, "reason": "no running tasks"}

    # Skip the write when the record is already right. This only saves Route53
    # calls; it does not order concurrent invocations. The re-read and the
    # marker below do that.
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

    # Re-read just before writing: if the running set changed meanwhile, drop
    # out rather than publish a dead address.
    fresh = set(_running_task_ips())
    if fresh != set(ips):
        print("the running set changed while this invocation ran; leaving the write to the newer event")
        return {"updated": False, "reason": "superseded"}

    # Ordering. Every write stores its ECS event time in a TXT marker beside
    # the A record, and an invocation stands down when the marker is newer than
    # its own event, so the newest event wins rather than the last writer.
    # Route53 has no conditional write, so a small window remains between this
    # read and the write; a wrong record surfaces as a 502 and the next task
    # event corrects it. Serialising instead would need reserved concurrency
    # (refused on this account, see discovery.tf) or a FIFO queue.
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
                        # Every running task: a deploy briefly runs two, and
                        # CloudFront may use either.
                        "ResourceRecords": [{"Value": ip} for ip in ips],
                    },
                },
                {
                    # Same batch as the A record: Route53 applies a batch
                    # atomically, so the two cannot disagree.
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
