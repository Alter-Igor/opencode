#!/usr/bin/env python3
"""#118: egress checks that run INSIDE the sandbox, as the non-sudo agent user.

Usage: python3 checks.py <plan.json>   -> prints one JSON array of results.
A plan item is {"id", "kind": "tcp"|"udp-dns"|"udp6-send", "host", "port"}.

       python3 checks.py --hold <targets.json> <ready-file> <go-file> <out.json>
Opens a connection to each target BEFORE lockdown, writes <ready-file>, waits for <go-file>, then
checks whether the held connection still gets through. A target is {"id", "host", "port"}.
Nothing here needs privileges; it only tries to connect or send.
"""
import json
import os
import socket
import sys
import time

TIMEOUT = 3.0
# A DNS query for example.com (type A).
DNS_QUERY = bytes.fromhex("abcd01000001000000000000076578616d706c6503636f6d0000010001")


def tcp(host, port):
    """TCP connect; reachable only if the handshake completes."""
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
    """Send one DNS query; reachable only if a reply arrives."""
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


def poke(s):
    """Send a request and wait for the reply. True only if reply DATA came back (the request got out);
    False on timeout; None when the peer closed or reset, which it can do on its own while our
    packets are dropped, so that proves nothing either way."""
    s.setblocking(False)
    try:
        if s.recv(1, socket.MSG_PEEK) == b"":
            return None, "peer had already closed"
    except BlockingIOError:
        pass
    except OSError as e:
        return None, "already broken: " + (e.strerror or str(e))
    s.settimeout(TIMEOUT)
    try:
        s.sendall(b"GET / HTTP/1.0\r\nHost: sbxw\r\n\r\n")
        data = s.recv(64)
        if data:
            return True, "answered with %d bytes" % len(data)
        return None, "peer closed without data"
    except socket.timeout:
        return False, "timeout"
    except OSError as e:
        return None, e.strerror or str(e)


def hold(targets_file, ready_file, go_file, out_file):
    """For each target: a fresh connection must answer before lockdown (else the check proves
    nothing); a second one, opened before lockdown and held, must NOT get through after it."""
    targets = json.load(open(targets_file))
    held = []
    for t in targets:
        item = {"id": t["id"], "answeredBefore": False, "answeredAfter": None, "detail": ""}
        try:
            probe = socket.create_connection((t["host"], int(t["port"])), timeout=TIMEOUT)
            answered, item["detail"] = poke(probe)
            item["answeredBefore"] = answered is True
            probe.close()
            held.append((item, socket.create_connection((t["host"], int(t["port"])), timeout=TIMEOUT)))
        except OSError as e:
            item["detail"] = "could not open before lockdown: " + (e.strerror or str(e))
            held.append((item, None))
    open(ready_file, "w").write("ready")
    deadline = time.time() + 300
    while not os.path.exists(go_file) and time.time() < deadline:
        time.sleep(0.5)
    results = []
    for item, s in held:
        if s is not None:
            item["answeredAfter"], after = poke(s)
            item["detail"] = (item["detail"] + "; after: " + after).strip("; ")
            s.close()
        results.append(item)
    json.dump(results, open(out_file, "w"))


KINDS = {"tcp": tcp, "udp-dns": udp_dns, "udp6-send": udp6_send}


def main():
    """Run every plan item and print the results as one JSON array."""
    if sys.argv[1] == "--hold":
        hold(*sys.argv[2:6])
        return
    plan = json.load(open(sys.argv[1]))
    results = []
    for item in plan:
        reachable, detail = KINDS[item["kind"]](item["host"], int(item["port"]))
        results.append({"id": item["id"], "reachable": reachable, "detail": detail})
    print(json.dumps(results))


if __name__ == "__main__":
    main()
