import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict

from fastapi import FastAPI


PENGER_FILE = Path(__file__).parent / "penger.txt"
REFRESH_SECONDS = 60

balances: Dict[str, float] = {}
balances_lock = asyncio.Lock()
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


async def refresh_loop() -> None:
    while True:
        await load_balances_once()
        await asyncio.sleep(REFRESH_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global refresh_task

    await load_balances_once()  # load immediately on startup
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


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}