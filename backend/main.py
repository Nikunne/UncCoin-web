import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI


PENGER_FILE = Path(__file__).parent / "penger.txt"
BLOCKCHAIN_FILE = Path(__file__).parent / "blockchain.json"
REFRESH_SECONDS = 10

balances: Dict[str, float] = {}
balances_lock = asyncio.Lock()
blockchain: Dict[str, Any] = {}
blockchain_lock = asyncio.Lock()
refresh_task: asyncio.Task | None = None


def parse_penger_file(text: str) -> Dict[str, float]:
    parsed: Dict[str, float] = {}

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        # Ignore headers such as "Balances:"
        if line.endswith(":") and ":" not in line[:-1]:
            continue

        if ":" not in line:
            continue

        wallet, amount_str = line.split(":", 1)
        wallet = wallet.strip()
        amount_str = amount_str.strip()

        if not wallet:
            continue

        try:
            parsed[wallet] = float(amount_str)
        except ValueError:
            # Skip malformed amount lines
            continue

    return parsed


async def load_balances_once() -> None:
    if not PENGER_FILE.exists():
        return

    try:
        text = PENGER_FILE.read_text(encoding="utf-8")
    except FileNotFoundError:
        # Handle the case where the file is not found
        print(f"Error: {PENGER_FILE} not found.")
        return
    except Exception as e:
        # Handle other potential file reading errors
        print(f"Error reading {PENGER_FILE}: {e}")
        return

    parsed = parse_penger_file(text)

    async with balances_lock:
        balances.clear()
        balances.update(parsed)


async def load_blockchain_once() -> None:
    if not BLOCKCHAIN_FILE.exists():
        return

    try:
        text = BLOCKCHAIN_FILE.read_text(encoding="utf-8")
        parsed = json.loads(text)
    except FileNotFoundError:
        print(f"Error: {BLOCKCHAIN_FILE} not found.")
        return
    except json.JSONDecodeError as error:
        print(f"Error parsing {BLOCKCHAIN_FILE}: {error}")
        return
    except Exception as error:
        print(f"Error reading {BLOCKCHAIN_FILE}: {error}")
        return

    if not isinstance(parsed, dict):
        print(f"Error: {BLOCKCHAIN_FILE} does not contain a JSON object.")
        return

    async with blockchain_lock:
        blockchain.clear()
        blockchain.update(parsed)


async def refresh_loop() -> None:
    while True:
        await load_balances_once()
        await load_blockchain_once()
        await asyncio.sleep(REFRESH_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global refresh_task

    await load_balances_once()  # load immediately on startup
    await load_blockchain_once()
    refresh_task = asyncio.create_task(refresh_loop())

    try:
        yield
    finally:
        if refresh_task:
            refresh_task.cancel()
            try:
                await refresh_task
            except asyncio.CancelledError:
                pass


app = FastAPI(title="Wallet Balances API", lifespan=lifespan)


@app.get("/balances")
async def get_balances() -> Dict[str, float]:
    async with balances_lock:
        return dict(balances)


@app.get("/blockchain")
async def get_blockchain() -> Dict[str, Any]:
    async with blockchain_lock:
        return dict(blockchain)


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}
