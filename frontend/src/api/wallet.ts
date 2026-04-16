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

export type BrowserWallet = {
    wallet_address: string;
    wallet_name: string;
    created_at: string;
};

export type WalletSession = {
    token: string;
    browser_wallet: BrowserWallet;
    wallet: WalletSummary;
};

export type BonusAmountSettings = {
    bonus_amount: string;
};

type WalletSessionApiResponse = {
    ok: boolean;
    token?: string;
    browser_wallet: BrowserWallet;
    wallet: WalletSummary;
    command_output?: string;
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

function normalizeBrowserWallet(value: unknown): BrowserWallet {
    const wallet = (value ?? {}) as Partial<BrowserWallet>;

    return {
        wallet_address: typeof wallet.wallet_address === "string" ? wallet.wallet_address : "",
        wallet_name: typeof wallet.wallet_name === "string" ? wallet.wallet_name : "",
        created_at: typeof wallet.created_at === "string" ? wallet.created_at : "",
    };
}

function normalizeWalletSessionResponse(value: unknown): WalletSessionApiResponse {
    const response = (value ?? {}) as Partial<WalletSessionApiResponse>;

    return {
        ok: response.ok === true,
        token: typeof response.token === "string" ? response.token : undefined,
        browser_wallet: normalizeBrowserWallet(response.browser_wallet),
        wallet: normalizeWalletSummary(response.wallet),
        command_output: typeof response.command_output === "string" ? response.command_output : undefined,
    };
}

function normalizeBonusAmountSettings(value: unknown): BonusAmountSettings {
    const response = (value ?? {}) as Partial<BonusAmountSettings>;

    return {
        bonus_amount: typeof response.bonus_amount === "string" ? response.bonus_amount : "1",
    };
}

async function parseError(response: Response): Promise<never> {
    const data = (await response.json().catch(() => null)) as
        | { detail?: string | Array<{ loc?: unknown[]; msg?: string }> }
        | null;

    if (Array.isArray(data?.detail)) {
        const message = data.detail
            .map((entry) => {
                const location = Array.isArray(entry.loc) ? entry.loc.slice(1).join(".") : "request";
                const detail = typeof entry.msg === "string" ? entry.msg : "Invalid value";
                return `${location}: ${detail}`;
            })
            .join(". ");

        throw new Error(message || `Request failed: ${response.status}`);
    }

    throw new Error(typeof data?.detail === "string" ? data.detail : `Request failed: ${response.status}`);
}

export async function loginWithWallet(walletIdentifier: string, password: string): Promise<WalletSession> {
    const response = await fetch(`${API_BASE_URL}/wallet-login`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            wallet_address: walletIdentifier,
            password,
        }),
    });

    if (!response.ok) {
        await parseError(response);
    }

    const data = normalizeWalletSessionResponse(await response.json());
    if (!data.token) {
        throw new Error("Wallet session token was missing from the response");
    }

    return {
        token: data.token,
        browser_wallet: data.browser_wallet,
        wallet: data.wallet,
    };
}

export async function createBrowserWallet(walletName: string, password: string): Promise<WalletSession> {
    const response = await fetch(`${API_BASE_URL}/browser-wallets`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            wallet_name: walletName,
            password,
        }),
    });

    if (!response.ok) {
        await parseError(response);
    }

    const data = normalizeWalletSessionResponse(await response.json());
    if (!data.token) {
        throw new Error("Wallet session token was missing from the response");
    }

    return {
        token: data.token,
        browser_wallet: data.browser_wallet,
        wallet: data.wallet,
    };
}

export async function getWalletSession(token: string): Promise<Omit<WalletSession, "token">> {
    const response = await fetch(`${API_BASE_URL}/wallet-session`, {
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });

    if (!response.ok) {
        await parseError(response);
    }

    const data = normalizeWalletSessionResponse(await response.json());
    return {
        browser_wallet: data.browser_wallet,
        wallet: data.wallet,
    };
}

export async function logoutWalletSession(token: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/wallet-session/logout`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });

    if (!response.ok) {
        await parseError(response);
    }
}

export async function sendWalletTransaction(
    token: string,
    receiverAddress: string,
    amount: string,
    fee: string,
): Promise<Omit<WalletSession, "token"> & { command_output?: string }> {
    const response = await fetch(`${API_BASE_URL}/wallet-send`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
            receiver_address: receiverAddress,
            amount,
            fee,
        }),
    });

    if (!response.ok) {
        await parseError(response);
    }

    const data = normalizeWalletSessionResponse(await response.json());
    return {
        browser_wallet: data.browser_wallet,
        wallet: data.wallet,
        command_output: data.command_output,
    };
}

export async function getWalletSummary(walletAddress: string): Promise<WalletSummary> {
    const response = await fetch(`${API_BASE_URL}/wallets/${encodeURIComponent(walletAddress)}`);

    if (!response.ok) {
        await parseError(response);
    }

    return normalizeWalletSummary(await response.json());
}

export async function getBonusAmount(token: string): Promise<BonusAmountSettings> {
    const response = await fetch(`${API_BASE_URL}/bonus-amount`, {
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });

    if (!response.ok) {
        await parseError(response);
    }

    return normalizeBonusAmountSettings(await response.json());
}

export async function updateBonusAmount(token: string, bonusAmount: string): Promise<BonusAmountSettings> {
    const response = await fetch(`${API_BASE_URL}/bonus-amount`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
            bonus_amount: bonusAmount,
        }),
    });

    if (!response.ok) {
        await parseError(response);
    }

    return normalizeBonusAmountSettings(await response.json());
}
