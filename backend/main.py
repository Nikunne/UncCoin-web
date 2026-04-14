import asyncio
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime
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


def parse_timestamp(value: Any) -> float | None:
    if not isinstance(value, str) or not value.strip():
        return None

    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"

    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)

    return parsed.timestamp()


def collect_wallet_addresses(chain_data: Dict[str, Any]) -> set[str]:
    wallet_addresses: set[str] = set()

    chain_wallet_address = chain_data.get("wallet_address")
    if isinstance(chain_wallet_address, str) and chain_wallet_address.strip():
        wallet_addresses.add(chain_wallet_address.strip())

    for block in chain_data.get("blocks", []):
        description = block.get("description")
        if isinstance(description, str) and description.strip():
            wallet_addresses.add(description.strip())

        for transaction in block.get("transactions", []):
            sender = transaction.get("sender")
            receiver = transaction.get("receiver")

            if isinstance(sender, str) and sender.strip():
                wallet_addresses.add(sender.strip())

            if isinstance(receiver, str) and receiver.strip():
                wallet_addresses.add(receiver.strip())

    return wallet_addresses


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
    activity: list[Dict[str, Any]] = []

    for block in blocks:
        transactions = block.get("transactions", [])
        block_has_wallet_activity = False
        mining_reward_in_block = 0.0
        block_timestamp: str | None = None

        for transaction in transactions:
            amount = parse_amount(transaction.get("amount"))
            fee = parse_amount(transaction.get("fee"))
            sender = transaction.get("sender")
            receiver = transaction.get("receiver")
            timestamp = transaction.get("timestamp")

            if not block_timestamp and isinstance(timestamp, str) and timestamp.strip():
                block_timestamp = timestamp

            if sender == wallet_address:
                sent_count += 1
                total_sent += amount
                total_fees_paid += fee
                block_has_wallet_activity = True
                activity.append(
                    {
                        "block_id": block.get("block_id"),
                        "kind": "sent",
                        "sender": sender,
                        "receiver": receiver,
                        "amount": amount,
                        "fee": fee,
                        "timestamp": timestamp,
                    }
                )
                if timestamp:
                    latest_activity = timestamp

            if receiver == wallet_address:
                received_count += 1
                total_received += amount
                block_has_wallet_activity = True
                if sender == "SYSTEM":
                    mining_reward_in_block += amount
                activity.append(
                    {
                        "block_id": block.get("block_id"),
                        "kind": "mined" if sender == "SYSTEM" and block.get("description") == wallet_address else "received",
                        "sender": sender,
                        "receiver": receiver,
                        "amount": amount,
                        "fee": fee,
                        "timestamp": timestamp,
                    }
                )
                if timestamp:
                    latest_activity = timestamp

        if block.get("description") == wallet_address:
            mined_block_count += 1
            if mining_reward_in_block <= 0:
                activity.append(
                    {
                        "block_id": block.get("block_id"),
                        "kind": "mined",
                        "sender": "SYSTEM",
                        "receiver": wallet_address,
                        "amount": 0.0,
                        "fee": 0.0,
                        "timestamp": block_timestamp,
                    }
                )

        if block_has_wallet_activity:
            block_appearance_count += 1

    activity.sort(
        key=lambda entry: (
            parse_timestamp(entry.get("timestamp")) or float("-inf"),
            entry.get("block_id") if isinstance(entry.get("block_id"), int) else -1,
        ),
        reverse=True,
    )

    latest_activity = next(
        (
            entry.get("timestamp")
            for entry in activity
            if isinstance(entry.get("timestamp"), str) and entry.get("timestamp").strip()
        ),
        latest_activity,
    )

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
        "activity": activity,
    }


async def get_wallet_balance(wallet_address: str) -> float | None:
    async with balances_lock:
        return balances.get(wallet_address)


async def get_wallet_summary(wallet_address: str) -> Dict[str, Any]:
    async with blockchain_lock:
        chain_data = dict(blockchain)

    if wallet_address not in collect_wallet_addresses(chain_data):
        raise HTTPException(status_code=404, detail="Wallet address not found in blockchain data")

    balance = await get_wallet_balance(wallet_address)
    return build_wallet_stats(wallet_address, balance or 0.0, chain_data)


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
