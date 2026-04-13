import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


PENGER_FILE = Path(__file__).parent / "penger.txt"
BLOCKCHAIN_FILE = Path(__file__).parent / "blockchain.json"
REFRESH_SECONDS = 10

balances: Dict[str, float] = {}
balances_lock = asyncio.Lock()
blockchain: Dict[str, Any] = {}
blockchain_lock = asyncio.Lock()
refresh_task: asyncio.Task | None = None
TEMP_WALLET_PASSWORD = "1234"


class WalletLoginRequest(BaseModel):
    wallet_address: str
    password: str


def parse_amount(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def build_wallet_stats(wallet_address: str, balance: float, chain_data: Dict[str, Any]) -> Dict[str, Any]:
    blocks = chain_data.get("blocks", [])
    sent_count = 0
    received_count = 0
    total_sent = 0.0
    total_received = 0.0
    total_fees_paid = 0.0
    mined_block_count = 0
    block_appearance_count = 0
    latest_activity: str | None = None

    for block in blocks:
        transactions = block.get("transactions", [])
        block_has_wallet_activity = False

        for transaction in transactions:
            amount = parse_amount(transaction.get("amount"))
            fee = parse_amount(transaction.get("fee"))
            sender = transaction.get("sender")
            receiver = transaction.get("receiver")
            timestamp = transaction.get("timestamp")

            if sender == wallet_address:
                sent_count += 1
                total_sent += amount
                total_fees_paid += fee
                block_has_wallet_activity = True
                if timestamp:
                    latest_activity = timestamp

            if receiver == wallet_address:
                received_count += 1
                total_received += amount
                block_has_wallet_activity = True
                if timestamp:
                    latest_activity = timestamp

        if block.get("description") == wallet_address:
            mined_block_count += 1

        if block_has_wallet_activity:
            block_appearance_count += 1

    return {
        "wallet_address": wallet_address,
        "balance": balance,
        "transaction_count": sent_count + received_count,
        "sent_count": sent_count,
        "received_count": received_count,
        "total_sent": total_sent,
        "total_received": total_received,
        "total_fees_paid": total_fees_paid,
        "mined_block_count": mined_block_count,
        "block_appearance_count": block_appearance_count,
        "latest_activity": latest_activity,
    }


async def get_wallet_balance(wallet_address: str) -> float | None:
    async with balances_lock:
        return balances.get(wallet_address)


async def get_wallet_summary(wallet_address: str) -> Dict[str, Any]:
    balance = await get_wallet_balance(wallet_address)

    if balance is None:
        raise HTTPException(status_code=404, detail="Wallet address not found")

    async with blockchain_lock:
        chain_data = dict(blockchain)

    return build_wallet_stats(wallet_address, balance, chain_data)


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


@app.post("/wallet-login")
async def wallet_login(payload: WalletLoginRequest) -> Dict[str, Any]:
    wallet_address = payload.wallet_address.strip()

    if not wallet_address:
        raise HTTPException(status_code=400, detail="Wallet address is required")

    if payload.password != TEMP_WALLET_PASSWORD:
        raise HTTPException(status_code=401, detail="Invalid wallet address or password")

    summary = await get_wallet_summary(wallet_address)
    return {
        "ok": True,
        "wallet": summary,
    }


@app.get("/wallets/{wallet_address}")
async def get_wallet(wallet_address: str) -> Dict[str, Any]:
    return await get_wallet_summary(wallet_address)


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}
