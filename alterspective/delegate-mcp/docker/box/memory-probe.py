#!/usr/bin/python3
"""#49. Run with -I -S. Never return memory contents, env values, or command arguments."""
import ctypes
import errno
import json
import os
import re
import sys


def denied(call):
    try:
        call()
        return False
    except OSError as error:
        return error.errno in (errno.EPERM, errno.EACCES)


def check(pid, startup):
    root = "/proc/" + str(pid)
    with open("/proc/sys/kernel/yama/ptrace_scope") as source:
        scope = int(source.read().strip())
    with open(root + "/status") as source:
        status = source.read()
    uid = re.search(r"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$", status, re.M)
    if not uid or any(int(value) != os.getuid() for value in uid.groups()):
        raise RuntimeError("probe must use the server uid")
    with open(root + "/limits") as source:
        core = bool(re.search(r"^Max core file size\s+0\s+0\s+bytes[ \t]*$", source.read(), re.M))
    with open(root + "/environ", "rb") as source:
        env = dict(item.split(b"=", 1) for item in source.read().split(b"\0") if b"=" in item)
    with open(root + "/cmdline", "rb") as source:
        command = source.read().rstrip(b"\0").split(b"\0")
    bad_env = any(name in (b"NODE_OPTIONS", b"NODE_PATH", b"OPENCODE_AUTO_HEAP_SNAPSHOT") or name.startswith((b"LD_", b"DYLD_", b"JSC_", b"BUN_INSPECT")) or name == b"BUN_OPTIONS" for name in env)
    debug = not bad_env and not any(b"--inspect" in arg or b"--debug" in arg for arg in command)
    verifier = b"OPENCODE_SERVER_PASSWORD" not in env and bool(re.fullmatch(b"[a-f0-9]{64}", env.get(b"OPENCODE_SERVER_PASSWORD_SHA256", b"")))
    restrictions = all(env.get(name) == b"1" for name in (b"OPENCODE_DISABLE_REMOTE_CONFIG", b"OPENCODE_DISABLE_EXTERNAL_PROVIDERS", b"OPENCODE_DISABLE_PROJECT_CONFIG", b"OPENCODE_DISABLE_EXTERNAL_SKILLS", b"OPENCODE_DISABLE_CLAUDE_CODE"))
    # The startup child probes its waiting parent, which execs the server at the same pid.
    server = startup or command == [b"/usr/local/bin/opencode", b"serve", b"--hostname", b"0.0.0.0", b"--port", b"4096"]

    def mem():
        os.close(os.open(root + "/mem", os.O_RDONLY))

    libc = ctypes.CDLL(None, use_errno=True)
    libc.ptrace.restype = ctypes.c_long
    libc.ptrace.argtypes = [ctypes.c_uint, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]

    def ptrace():
        if libc.ptrace(16, pid, None, None) == -1:  # PTRACE_ATTACH
            raise OSError(ctypes.get_errno(), "ptrace")
        # Unsafe hosts still get a clean failure: resume the exact process this probe stopped.
        os.waitpid(pid, 0)
        libc.ptrace(17, pid, None, None)  # PTRACE_DETACH

    class Iovec(ctypes.Structure):
        _fields_ = [("base", ctypes.c_void_p), ("length", ctypes.c_size_t)]

    def vm_read():
        output = ctypes.c_char()
        local = Iovec(ctypes.addressof(output), 1)
        remote = Iovec(None, 1)
        libc.process_vm_readv.restype = ctypes.c_ssize_t
        libc.process_vm_readv.argtypes = [ctypes.c_int, ctypes.POINTER(Iovec), ctypes.c_ulong, ctypes.POINTER(Iovec), ctypes.c_ulong, ctypes.c_ulong]
        if libc.process_vm_readv(pid, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0) == -1:
            # EFAULT is not denial: permission was granted, so only EPERM/EACCES passes.
            raise OSError(ctypes.get_errno(), "process_vm_readv")

    sockets = set()
    for name in os.listdir(root + "/fd"):
        try:
            link = os.readlink(root + "/fd/" + name)
            if link.startswith("socket:["):
                sockets.add(link[8:-1])
        except FileNotFoundError:
            pass  # A request may close while the probe runs.
    ports = set()
    for family in ("tcp", "tcp6"):
        with open(root + "/net/" + family) as source:
            for line in source.readlines()[1:]:
                fields = line.split()
                if fields[3] == "0A" and fields[9] in sockets:
                    ports.add(int(fields[1].split(":")[1], 16))
    result = dict(ptraceScope=scope, memDenied=denied(mem), ptraceDenied=denied(ptrace), vmReadDenied=denied(vm_read), coreDisabled=core, debuggerDisabled=debug, verifierOnly=verifier, codeLoadingRestricted=restrictions, serverCommand=server, listeningPorts=sorted(ports))
    result["ok"] = 1 <= scope <= 3 and all(result[key] for key in ("memDenied", "ptraceDenied", "vmReadDenied", "coreDisabled", "debuggerDisabled", "verifierOnly", "codeLoadingRestricted", "serverCommand")) and ports == (set() if startup else {4096})
    return result


try:
    startup = sys.argv[1:] == ["--startup"]
    if not startup and not (len(sys.argv) == 3 and sys.argv[1] == "--check" and sys.argv[2].isdigit()):
        raise ValueError("invalid probe arguments")
    result = check(os.getppid() if startup else int(sys.argv[2]), startup)
except Exception:
    result = {"ok": False}
print(json.dumps(result, separators=(",", ":")))
sys.exit(0 if result["ok"] else 1)
