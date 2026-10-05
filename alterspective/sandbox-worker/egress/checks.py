#!/usr/bin/env python3
"""#118: egress checks that run INSIDE the sandbox, as the non-sudo agent user.

Usage: python3 checks.py <plan.json>   -> prints one JSON array of results.
A plan item is {"id", "kind": "tcp"|"udp-dns"|"udp6-send", "host", "port"}.
Nothing here needs privileges; it only tries to connect or send.
"""
import json
import socket
import sys

TIMEOUT = 3.0
# A DNS query for example.com (type A).
DNS_QUERY = bytes.fromhex("abcd01000001000000000000076578616d706c6503636f6d0000010001")


def tcp(host, port):
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    s = socket.socket(family, socket.SOCK_STREAM)
    s.settimeout(TIMEOUT)
    try:
        s.connect((host, port))
        return True, "connected"
    except socket.timeout:
        return False, "timeout"
    except OSError as e:
        return False, e.strerror or str(e)
    finally:
        s.close()


def udp_dns(host, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(TIMEOUT)
    try:
        s.sendto(DNS_QUERY, (host, port))
        s.recvfrom(512)
        return True, "reply"
    except socket.timeout:
        return False, "timeout"
    except OSError as e:
        return False, e.strerror or str(e)
    finally:
        s.close()


def udp6_send(host, port):
    """Send one IPv6 datagram to an on-link address. Routing accepts it, so it reaches the output
    hook: the firewall's ipv6 counter proves the drop even when nothing would have answered."""
    s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
    try:
        scope = socket.if_nametoindex("eth0")
        s.sendto(b"sbxw-egress-probe", (host, port, 0, scope))
        return False, "sent (no reply expected; see the ipv6 counter)"
    except OSError as e:
        return False, e.strerror or str(e)
    finally:
        s.close()


KINDS = {"tcp": tcp, "udp-dns": udp_dns, "udp6-send": udp6_send}


def main():
    plan = json.load(open(sys.argv[1]))
    results = []
    for item in plan:
        reachable, detail = KINDS[item["kind"]](item["host"], int(item["port"]))
        results.append({"id": item["id"], "reachable": reachable, "detail": detail})
    print(json.dumps(results))


if __name__ == "__main__":
    main()
