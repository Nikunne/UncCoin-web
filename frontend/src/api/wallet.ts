const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";

export type WalletActivityItem = {
    block_id: number | null;
    kind: "sent" | "received" | "mined";
    sender: string;
    receiver: string;
    amount: number;
    fee: number;
    timestamp: string | null;
};

export type WalletSummary = {
    wallet_address: string;
    balance: number;
    transaction_count: number;
    sent_count: number;
    received_count: number;
    total_sent: number;
    total_received: number;
    total_fees_paid: number;
    mined_block_count: number;
    block_appearance_count: number;
    latest_activity: string | null;
    activity: WalletActivityItem[];
};

type WalletLoginResponse = {
    ok: boolean;
    wallet: WalletSummary;
};

function asNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function normalizeWalletActivity(value: unknown): WalletActivityItem[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.map((entry) => {
        const item = entry as Partial<WalletActivityItem>;

        return {
            block_id: typeof item.block_id === "number" ? item.block_id : null,
            kind:
                item.kind === "sent" || item.kind === "received" || item.kind === "mined"
                    ? item.kind
                    : "received",
            sender: typeof item.sender === "string" ? item.sender : "",
            receiver: typeof item.receiver === "string" ? item.receiver : "",
            amount: asNumber(item.amount),
            fee: asNumber(item.fee),
            timestamp: asString(item.timestamp),
        };
    });
}

function normalizeWalletSummary(value: unknown): WalletSummary {
    const wallet = (value ?? {}) as Partial<WalletSummary>;

    return {
        wallet_address: typeof wallet.wallet_address === "string" ? wallet.wallet_address : "",
        balance: asNumber(wallet.balance),
        transaction_count: asNumber(wallet.transaction_count),
        sent_count: asNumber(wallet.sent_count),
        received_count: asNumber(wallet.received_count),
        total_sent: asNumber(wallet.total_sent),
        total_received: asNumber(wallet.total_received),
        total_fees_paid: asNumber(wallet.total_fees_paid),
        mined_block_count: asNumber(wallet.mined_block_count),
        block_appearance_count: asNumber(wallet.block_appearance_count),
        latest_activity: asString(wallet.latest_activity),
        activity: normalizeWalletActivity(wallet.activity),
    };
}

export async function loginWithWallet(walletAddress: string, password: string): Promise<WalletSummary> {
    const response = await fetch(`${API_BASE_URL}/wallet-login`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            wallet_address: walletAddress,
            password,
        }),
    });

    if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? `Failed to log in: ${response.status}`);
    }

    const data = (await response.json()) as WalletLoginResponse;
    return normalizeWalletSummary(data.wallet);
}

export async function getWalletSummary(walletAddress: string): Promise<WalletSummary> {
    const response = await fetch(`${API_BASE_URL}/wallets/${encodeURIComponent(walletAddress)}`);

    if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? `Failed to fetch wallet: ${response.status}`);
    }

    return normalizeWalletSummary(await response.json());
}
