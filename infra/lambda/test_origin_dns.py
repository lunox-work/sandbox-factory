"""DNS discovery must never advertise preparation or migration workers."""

import importlib.util
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


class OriginDnsTest(unittest.TestCase):
    def setUp(self):
        os.environ.update(HOSTED_ZONE_ID="zone", RECORD_NAME="api.example.test", CLUSTER="cluster")
        self.ecs = Mock()
        self.ec2 = Mock()
        self.route53 = Mock()
        clients = {"ecs": self.ecs, "ec2": self.ec2, "route53": self.route53}
        sys.modules["boto3"] = SimpleNamespace(client=lambda name: clients[name])
        spec = importlib.util.spec_from_file_location("origin_dns", Path(__file__).with_name("origin_dns.py"))
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def test_only_api_service_tasks_are_advertised(self):
        self.ecs.list_tasks.return_value = {"taskArns": ["api", "worker", "migration", "stopped"]}
        tasks = []
        for name, group, status in [
            ("api", "service:sandbox-factory-api", "RUNNING"),
            ("worker", "family:sandbox-factory-worker", "RUNNING"),
            ("migration", "family:sandbox-factory-migrate", "RUNNING"),
            ("stopped", "service:sandbox-factory-api", "STOPPED"),
        ]:
            tasks.append({"group": group, "lastStatus": status, "attachments": [{
                "type": "ElasticNetworkInterface", "details": [{"name": "networkInterfaceId", "value": name}]
            }]})
        self.ecs.describe_tasks.return_value = {"tasks": tasks}
        self.ec2.describe_network_interfaces.return_value = {"NetworkInterfaces": [{"Association": {"PublicIp": "192.0.2.1"}}]}
        self.assertEqual(self.module._running_task_ips(), ["192.0.2.1"])
        self.ec2.describe_network_interfaces.assert_called_once_with(NetworkInterfaceIds=["api"])

    def test_empty_cluster_does_not_describe_tasks(self):
        self.ecs.list_tasks.return_value = {}
        self.assertEqual(self.module._running_task_ips(), [])
        self.ecs.describe_tasks.assert_not_called()


if __name__ == "__main__":
    unittest.main()
