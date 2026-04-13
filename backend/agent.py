#!/usr/bin/env python3

#Wallet and node is already created and ran once



#This runs in the UncCoin-repo
import subprocess
import threading
import time
import sys
from pathlib import Path

WORKDIR = Path("/home/hus/krypto/UncCoin")
START_CMD = ["./scripts/run.sh", "riggaagent", "4040"]
PEER_CMD = "add-peer 100.71.105.5:5000"
BALANCE_CMD = "txtbalances ./penger.txt"
BLOCKCHAIN_CMD = "txtblockchain ./blockchain.json"
INITIAL_WAIT_SECONDS = 20
LOOP_INTERVAL_SECONDS = 30


def stream_output(pipe, prefix):
    for line in iter(pipe.readline, ''):
        if not line:
            break
        print(f"[{prefix}] {line}", end="")


def send_command(proc, cmd):
    if proc.stdin is None:
        raise RuntimeError("Process stdin is not available")
    print(f"[agent] sending: {cmd}")
    proc.stdin.write(cmd + "\n")
    proc.stdin.flush()


def main():
    if not WORKDIR.exists():
        print(f"[agent] missing working directory: {WORKDIR}", file=sys.stderr)
        sys.exit(1)

    print(f"[agent] starting in {WORKDIR}")
    proc = subprocess.Popen(
        START_CMD,
        cwd=WORKDIR,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    threading.Thread(target=stream_output, args=(proc.stdout, "stdout"), daemon=True).start()
    threading.Thread(target=stream_output, args=(proc.stderr, "stderr"), daemon=True).start()

    try:
        print(f"[agent] waiting {INITIAL_WAIT_SECONDS}s before first add-peer")
        time.sleep(INITIAL_WAIT_SECONDS)

        send_command(proc, PEER_CMD)

        while True:
            if proc.poll() is not None:
                print(f"[agent] child process exited with code {proc.returncode}", file=sys.stderr)
                sys.exit(proc.returncode or 1)

            send_command(proc, BALANCE_CMD)
            send_command(proc, BLOCKCHAIN_CMD)
            time.sleep(LOOP_INTERVAL_SECONDS)

    except KeyboardInterrupt:
        print("[agent] stopping")
    finally:
        try:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=10)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    main()
