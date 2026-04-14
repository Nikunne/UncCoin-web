import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Route, Routes, useNavigate } from "react-router-dom";
import { getBalances, type BalanceRow } from "./api/balances";
import { getBlockchain, type BlockchainBlock, type BlockchainResponse } from "./api/blockchain";
import { getWalletSummary, loginWithWallet, type WalletActivityItem, type WalletSummary } from "./api/wallet";
import "./App.css";

const INITIAL_BLOCKS_VISIBLE = 25;
const BLOCKS_PER_BATCH = 25;
const RECENT_BLOCK_STATS_WINDOW = 100;
const CHART_WIDTH = 920;
const CHART_HEIGHT = 352;
const CHART_PADDING_LEFT = 78;
const CHART_PADDING_RIGHT = 32;
const CHART_PADDING_TOP = 28;
const CHART_PADDING_BOTTOM = 76;
const CHART_TICK_COUNT = 5;
const CHART_Y_TICK_COUNT = 5;
const WALLET_SESSION_KEY = "unc-wallet-address";
const FEATURED_WALLET_ADDRESS = "2822fb2786ef939c5350a2bb84cb200f6779c9e9ed4652f7360fd243e2d95bd1";
const SECONDARY_WALLET_ADDRESS = "fe269f427a5ad619ce480192db583a29a7ce4098b22111d9b7216e2fee6bc964";
const INVESTMENT_BANNER_TEXT = ["Early investor? Click here!"];
const HEI_FREDERIK_PATTERN = /heifrederik\d*/i;
const WINDOWS_PATTERN = /windows/i;

function formatTimestamp(timestamp: string): string {
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) {
        return timestamp;
    }

    return parsed.toLocaleString();
}

function truncateHash(hash: string): string {
    if (hash.length <= 20) {
        return hash;
    }

    return `${hash.slice(0, 10)}...${hash.slice(-10)}`;
}

function parseAmount(value: string): number {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatWalletAmount(value: number): string {
    return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "0";
}

function formatTotalAmount(value: number): string {
    return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "0";
}

function formatActivityAmount(activity: WalletActivityItem): string {
    const prefix = activity.kind === "sent" ? "-" : "+";
    return `${prefix}${formatWalletAmount(activity.amount)} UNC`;
}

function getActivityTitle(activity: WalletActivityItem): string {
    if (activity.kind === "mined") {
        return "Mined block reward";
    }

    if (activity.kind === "sent") {
        return "Sent transaction";
    }

    return "Received transaction";
}

function parseTimestampMs(timestamp: string | null): number {
    if (!timestamp) {
        return Number.NEGATIVE_INFINITY;
    }

    const value = new Date(timestamp).getTime();
    return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

function buildWalletActivityFromBlockchain(
    walletAddress: string,
    chainData: BlockchainResponse | null,
): WalletActivityItem[] {
    if (!chainData) {
        return [];
    }

    const activity: WalletActivityItem[] = [];

    for (const block of chainData.blocks) {
        let miningRewardRecorded = false;
        let blockTimestamp: string | null = null;

        for (const transaction of block.transactions) {
            if (!blockTimestamp && transaction.timestamp) {
                blockTimestamp = transaction.timestamp;
            }

            const amount = parseAmount(transaction.amount);
            const fee = parseAmount(transaction.fee);

            if (transaction.sender === walletAddress) {
                activity.push({
                    block_id: block.block_id,
                    kind: "sent",
                    sender: transaction.sender,
                    receiver: transaction.receiver,
                    amount,
                    fee,
                    timestamp: transaction.timestamp,
                });
            }

            if (transaction.receiver === walletAddress) {
                const isMinedReward = transaction.sender === "SYSTEM" && block.description === walletAddress;

                activity.push({
                    block_id: block.block_id,
                    kind: isMinedReward ? "mined" : "received",
                    sender: transaction.sender,
                    receiver: transaction.receiver,
                    amount,
                    fee,
                    timestamp: transaction.timestamp,
                });

                if (isMinedReward) {
                    miningRewardRecorded = true;
                }
            }
        }

        if (block.description === walletAddress && !miningRewardRecorded) {
            activity.push({
                block_id: block.block_id,
                kind: "mined",
                sender: "SYSTEM",
                receiver: walletAddress,
                amount: 0,
                fee: 0,
                timestamp: blockTimestamp,
            });
        }
    }

    activity.sort((left, right) => {
        const timestampDelta = parseTimestampMs(right.timestamp) - parseTimestampMs(left.timestamp);

        if (timestampDelta !== 0) {
            return timestampDelta;
        }

        return (right.block_id ?? -1) - (left.block_id ?? -1);
    });

    return activity;
}

function formatBlockShare(count: number, total: number): string {
    if (total <= 0) {
        return "0%";
    }

    const percentage = ((count / total) * 100).toFixed(1);
    return `${percentage.endsWith(".0") ? percentage.slice(0, -2) : percentage}%`;
}

function getWalletAddressClassName(baseClassName: string, address: string): string {
    if (address === FEATURED_WALLET_ADDRESS) {
        return `${baseClassName} featured-wallet-address`;
    }

    if (address === SECONDARY_WALLET_ADDRESS) {
        return `${baseClassName} secondary-wallet-address`;
    }

    return baseClassName;
}

function usePrevious<T>(value: T): T | undefined {
    const [previous, setPrevious] = useState<T>();

    useEffect(() => {
        setPrevious(value);
    }, [value]);

    return previous;
}

type SupplyPoint = {
    timestamp: string;
    timestampMs: number;
    totalSupply: number;
    label: string;
    dateLabel: string;
    timeLabel: string;
};

function buildSupplySeries(blocks: BlockchainBlock[]): SupplyPoint[] {
    let totalSupply = 0;
    const series: SupplyPoint[] = [];
    let fallbackTimestampMs = 0;

    for (const block of blocks) {
        let blockTimestamp: string | null = null;

        for (const transaction of block.transactions) {
            if (!blockTimestamp) {
                blockTimestamp = transaction.timestamp;
            }

            if (transaction.sender === "SYSTEM") {
                totalSupply += parseAmount(transaction.amount);
            }

            if (transaction.receiver === "SYSTEM") {
                totalSupply -= parseAmount(transaction.amount);
            }
        }

        if (blockTimestamp) {
            const parsed = new Date(blockTimestamp);
            const parsedTime = parsed.getTime();
            const hasValidTimestamp = !Number.isNaN(parsedTime);
            const timestampMs = hasValidTimestamp ? parsedTime : fallbackTimestampMs + 1;
            const dateLabel = hasValidTimestamp ? parsed.toLocaleDateString() : blockTimestamp;
            const timeLabel = hasValidTimestamp
                ? parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                : "";

            series.push({
                timestamp: blockTimestamp,
                timestampMs,
                totalSupply,
                label: formatTimestamp(blockTimestamp),
                dateLabel,
                timeLabel,
            });
            fallbackTimestampMs = timestampMs;
        }
    }

    return series;
}

function loadStoredWalletAddress(): string {
    if (typeof window === "undefined") {
        return "";
    }

    return window.localStorage.getItem(WALLET_SESSION_KEY) ?? "";
}

type YAxisTick = {
    value: number;
    y: number;
};

type XAxisTick = {
    value: number;
    x: number;
    dateLabel: string;
    timeLabel: string;
};

type NavItem = {
    to?: string;
    label: string;
    kind?: "default" | "login";
    active?: boolean;
    onClick?: () => void;
    disabled?: boolean;
};

type PageScaffoldProps = {
    children: ReactNode;
};

function TopInvestmentTicker() {
    const tickerItems = Array.from({ length: 12 }, () => INVESTMENT_BANNER_TEXT[0]);

    return (
        <a
            className="breaking-investment-banner"
            href="https://en.wikipedia.org/wiki/Exit_scam#Cryptocurrency_scams"
            target="_blank"
            rel="noreferrer"
        >
            <span className="breaking-investment-track" aria-hidden="true">
                {tickerItems.map((item, index) => (
                    <span key={`${item}-${index}`} className="breaking-investment-item">
                        {item}
                    </span>
                ))}
            </span>
            <span className="sr-only">Early investor? Click here!</span>
        </a>
    );
}

function PageNav({ items }: { items: NavItem[] }) {
    return (
        <nav className="page-actions" aria-label="Primary">
            {items.map((item) => {
                const className = [
                    "site-nav-link",
                    item.kind === "login" ? "site-nav-link-login" : "",
                    item.active ? "site-nav-link-active" : "",
                ]
                    .filter(Boolean)
                    .join(" ");

                return (
                    <div key={`${item.label}-${item.to ?? "button"}`} className="site-nav-item">
                        {item.to ? (
                            <Link className={className} to={item.to} aria-current={item.active ? "page" : undefined}>
                                {item.label}
                            </Link>
                        ) : (
                            <button
                                className={`${className} investment-button`}
                                type="button"
                                onClick={item.onClick}
                                disabled={item.disabled}
                            >
                                {item.label}
                            </button>
                        )}
                    </div>
                );
            })}
        </nav>
    );
}

function PageScaffold({ children }: PageScaffoldProps) {
    return (
        <div className="balances-page">
            <TopInvestmentTicker />
            {children}
        </div>
    );
}

type SplitFlapCellProps = {
    currentChar: string;
    nextChar: string;
    delay: number;
};

function SplitFlapCell({ currentChar, nextChar, delay }: SplitFlapCellProps) {
    const [isFlipping, setIsFlipping] = useState(false);

    useEffect(() => {
        if (currentChar === nextChar) {
            setIsFlipping(false);
            return;
        }

        setIsFlipping(true);
        const timeoutId = window.setTimeout(() => {
            setIsFlipping(false);
        }, 420 + delay);

        return () => {
            window.clearTimeout(timeoutId);
        };
    }, [currentChar, nextChar, delay]);

    const topChar = isFlipping ? currentChar : nextChar;
    const bottomChar = nextChar;
    const isBlank = nextChar === " ";

    return (
        <span
            className={`split-flap-cell${isFlipping ? " is-flipping" : ""}${isBlank ? " is-blank" : ""}`}
            style={{ animationDelay: `${delay}ms` }}
            aria-hidden="true"
        >
            <span className="split-flap-static split-flap-static-top">{topChar}</span>
            <span className="split-flap-static split-flap-static-bottom">{bottomChar}</span>
            {isFlipping ? (
                <>
                    <span className="split-flap-card split-flap-card-front">{currentChar}</span>
                    <span className="split-flap-card split-flap-card-back">{nextChar}</span>
                </>
            ) : null}
        </span>
    );
}

type SplitFlapTotalProps = {
    value: number;
};

function SplitFlapTotal({ value }: SplitFlapTotalProps) {
    const formattedValue = formatTotalAmount(value);
    const previousValue = usePrevious(formattedValue) ?? formattedValue;
    const length = Math.max(previousValue.length, formattedValue.length);
    const currentChars = previousValue.padStart(length, " ").split("");
    const nextChars = formattedValue.padStart(length, " ").split("");

    return (
        <span className="split-flap-total" aria-label={`Total UncCoins: ${formattedValue}`}>
            {nextChars.map((nextChar, index) => (
                <SplitFlapCell
                    key={`${index}-${currentChars[index]}-${nextChar}`}
                    currentChar={currentChars[index]}
                    nextChar={nextChar}
                    delay={index * 45}
                />
            ))}
        </span>
    );
}

function buildYAxisTicks(maxSupply: number): YAxisTick[] {
    return Array.from({ length: CHART_Y_TICK_COUNT }, (_, index) => {
        const ratio = index / (CHART_Y_TICK_COUNT - 1);
        const value = Math.round((1 - ratio) * maxSupply);
        const y = CHART_PADDING_TOP + ratio * (CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM);

        return { value, y };
    });
}

function buildXAxisTicks(minTimestamp: number, maxTimestamp: number): XAxisTick[] {
    if (minTimestamp === maxTimestamp) {
        const parsed = new Date(minTimestamp);

        return [
            {
                value: minTimestamp,
                x: CHART_PADDING_LEFT,
                dateLabel: parsed.toLocaleDateString([], { day: "2-digit", month: "2-digit" }),
                timeLabel: parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            },
        ];
    }

    return Array.from({ length: CHART_TICK_COUNT }, (_, index) => {
        const ratio = index / (CHART_TICK_COUNT - 1);
        const value = minTimestamp + ratio * (maxTimestamp - minTimestamp);
        const parsed = new Date(value);
        const x =
            CHART_PADDING_LEFT +
            ratio * (CHART_WIDTH - CHART_PADDING_LEFT - CHART_PADDING_RIGHT);

        return {
            value,
            x,
            dateLabel: parsed.toLocaleDateString([], { day: "2-digit", month: "2-digit" }),
            timeLabel: parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
    });
}

function HomePage() {
    const [balances, setBalances] = useState<BalanceRow[]>([]);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const [copiedUser, setCopiedUser] = useState<string | null>(null);
    const [copiedToast, setCopiedToast] = useState<string | null>(null);
    const [isCopyToastVisible, setIsCopyToastVisible] = useState(false);
    const totalUncCoins = balances.reduce((sum, [, amount]) => sum + amount, 0);

    useEffect(() => {
        let active = true;

        const load = async () => {
            try {
                const data = await getBalances();
                if (active) {
                    setBalances(data);
                    setLastUpdated(new Date());
                }
            } catch (error) {
                console.error(error);
            }
        };

        load();
        const fetchTimer = setInterval(load, 60_000);
        const reloadTimer = setInterval(() => {
            window.location.reload();
        }, 60_000);

        return () => {
            active = false;
            clearInterval(fetchTimer);
            clearInterval(reloadTimer);
        };
    }, []);

    const copyAddress = async (user: string) => {
        try {
            await navigator.clipboard.writeText(user);
            setCopiedUser(user);
            setCopiedToast(user);
            setIsCopyToastVisible(true);
            window.setTimeout(() => {
                setCopiedUser((current) => (current === user ? null : current));
            }, 1800);
            window.setTimeout(() => {
                setIsCopyToastVisible(false);
            }, 1000);
            window.setTimeout(() => {
                setCopiedToast((current) => (current === user ? null : current));
            }, 1800);
        } catch (error) {
            console.error(error);
        }
    };

    return (
        <PageScaffold>
            <PageNav
                items={[
                    { to: "/", label: "Balances", active: true },
                    { to: "/blockchain", label: "Blockchain" },
                    { to: "/stat", label: "Stats" },
                    { to: "/login", label: "Login", kind: "login" },
                ]}
            />
            <header className="masthead">
                <h1 className="balances-title">UncCoin</h1>
                <p className="masthead-subtitle">The most genuine cryptocurrency ever*</p>
            </header>

            <section className="balances-shell" aria-label="UncCoin balances">
                <div className="balances-meta">
                    <span className="balances-section-title">Balance Sheet</span>
                    <p className="total-unc-coins">
                        <span className="total-unc-coins-label">Total UncCoins:</span>
                        <SplitFlapTotal value={totalUncCoins} />
                    </p>
                </div>

                <div className="balances-submeta">
                    <div className="repo-notes" aria-label="Project notes">
                        <a
                            className="repo-link"
                            href="https://github.com/Fleli/UncCoin"
                            target="_blank"
                            rel="noreferrer"
                        >
                            Github-link for UncCoin
                        </a>
                        <a
                            className="repo-link"
                            href="https://github.com/Nikunne/UncCoin-web"
                            target="_blank"
                            rel="noreferrer"
                        >
                            Github-link for UncCoin-web
                        </a>
                    </div>
                    <p className="last-updated">
                        Last updated: {lastUpdated ? lastUpdated.toLocaleTimeString() : "loading..."}
                    </p>
                </div>

                <div className="balances-card">
                    {[...balances].reverse().map(([user, amount]) => (
                        <div key={user} className="balance-row">
                            <button
                                className={getWalletAddressClassName("balance-user", user)}
                                type="button"
                                onClick={() => {
                                    void copyAddress(user);
                                }}
                                title={`Copy ${user}`}
                            >
                                {user}
                            </button>
                            <div className="balance-row-footer">
                                <span className="balance-amount">{amount}</span>
                                <button
                                    className="balance-copy-button"
                                    type="button"
                                    onClick={() => {
                                        void copyAddress(user);
                                    }}
                                    aria-label={`Copy address ${user}`}
                                >
                                    {copiedUser === user ? "Copied" : "Copy"}
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
                <p>*Heard at Sit Hangaren, April 2026</p>
            </section>

            {copiedToast ? (
                <div
                    className={`copy-toast ${isCopyToastVisible ? "copy-toast-visible" : "copy-toast-hidden"}`}
                    role="status"
                    aria-live="polite"
                >
                    Copied wallet address: {copiedToast}
                </div>
            ) : null}
        </PageScaffold>
    );
}

function LoginPage() {
    const navigate = useNavigate();
    const [walletAddress, setWalletAddress] = useState("");
    const [password, setPassword] = useState("1234");
    const [errorMessage, setErrorMessage] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        const storedWalletAddress = loadStoredWalletAddress();
        if (storedWalletAddress) {
            navigate("/wallet", { replace: true });
        }
    }, [navigate]);

    const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setErrorMessage("");
        setIsSubmitting(true);

        try {
            const wallet = await loginWithWallet(walletAddress, password);
            window.localStorage.setItem(WALLET_SESSION_KEY, wallet.wallet_address);
            navigate("/wallet");
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "Failed to log in");
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <PageScaffold>
            <PageNav
                items={[
                    { to: "/", label: "Balances" },
                    { to: "/blockchain", label: "Blockchain" },
                    { to: "/stat", label: "Stats" },
                    { to: "/login", label: "Login", kind: "login", active: true },
                ]}
            />
            <header className="masthead masthead-left">
                <p className="masthead-kicker">Wallet Access</p>
                <h1 className="balances-title">UncCoin Login</h1>
                <p className="masthead-subtitle">
                    Log in with your wallet address. Temporary password for now: 1234.
                </p>
            </header>


            <section className="balances-shell login-shell" aria-label="Wallet login">
                <form className="wallet-login-form" onSubmit={onSubmit}>
                    <label className="wallet-login-field">
                        <span className="chain-stat-label">Wallet address</span>
                        <input
                            className="wallet-login-input"
                            value={walletAddress}
                            onChange={(event) => {
                                setWalletAddress(event.target.value);
                            }}
                            autoComplete="username"
                            placeholder="Enter wallet address"
                        />
                    </label>
                    <label className="wallet-login-field">
                        <span className="chain-stat-label">Password</span>
                        <input
                            className="wallet-login-input"
                            type="password"
                            value={password}
                            onChange={(event) => {
                                setPassword(event.target.value);
                            }}
                            autoComplete="current-password"
                        />
                    </label>
                    <div className="wallet-login-actions">
                        <button className="investment-link investment-button" type="submit" disabled={isSubmitting}>
                            {isSubmitting ? "Logging in..." : "Log in"}
                        </button>
                    </div>
                    {errorMessage ? <p className="wallet-login-error">{errorMessage}</p> : null}
                </form>
            </section>
        </PageScaffold>
    );
}

function WalletDashboardPage() {
    const navigate = useNavigate();
    const [walletAddress, setWalletAddress] = useState("");
    const [wallet, setWallet] = useState<WalletSummary | null>(null);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const [errorMessage, setErrorMessage] = useState("");

    useEffect(() => {
        const storedWalletAddress = loadStoredWalletAddress();

        if (!storedWalletAddress) {
            navigate("/login", { replace: true });
            return;
        }

        setWalletAddress(storedWalletAddress);
    }, [navigate]);

    useEffect(() => {
        if (!walletAddress) {
            return;
        }

        let active = true;

        const load = async () => {
            try {
                const data = await getWalletSummary(walletAddress);
                let nextWallet = data;

                if (data.activity.length === 0 && data.transaction_count > 0) {
                    const chainData = await getBlockchain();
                    const derivedActivity = buildWalletActivityFromBlockchain(walletAddress, chainData);

                    if (derivedActivity.length > 0) {
                        nextWallet = {
                            ...data,
                            activity: derivedActivity,
                            latest_activity: data.latest_activity ?? derivedActivity[0]?.timestamp ?? null,
                        };
                    }
                }

                if (active) {
                    setWallet(nextWallet);
                    setLastUpdated(new Date());
                    setErrorMessage("");
                }
            } catch (error) {
                if (active) {
                    const message = error instanceof Error ? error.message : "Failed to load wallet";
                    setErrorMessage(message);
                    if (message.toLowerCase().includes("not found")) {
                        window.localStorage.removeItem(WALLET_SESSION_KEY);
                        navigate("/login", { replace: true });
                    }
                }
            }
        };

        void load();
        const timer = window.setInterval(() => {
            void load();
        }, 10_000);

        return () => {
            active = false;
            window.clearInterval(timer);
        };
    }, [navigate, walletAddress]);

    const logOut = () => {
        window.localStorage.removeItem(WALLET_SESSION_KEY);
        navigate("/login");
    };

    return (
        <PageScaffold>
            <PageNav
                items={[
                    { to: "/", label: "Balances" },
                    { to: "/blockchain", label: "Blockchain" },
                    { to: "/stat", label: "Stats" },
                    { to: "/login", label: "Wallet", kind: "login", active: true },
                    { label: "Log out", onClick: logOut },
                ]}
            />
            <header className="masthead masthead-left">
                <p className="masthead-kicker">Wallet Dashboard</p>
                <h1 className="balances-title">My UncCoin Wallet</h1>
                <p className="masthead-subtitle">
                    Wallet-specific balance and activity pulled from the live balance sheet and blockchain data.
                </p>
            </header>


            <section className="balances-shell" aria-label="Logged in wallet">
                <div className="balances-meta">
                    <span className="balances-section-title">Logged In Wallet</span>
                    <p className="last-updated">
                        Last updated: {lastUpdated ? lastUpdated.toLocaleTimeString() : "loading..."}
                    </p>
                </div>

                <div className="chain-wallet-card">
                    <span className="chain-stat-label">Wallet Address</span>
                    <code className={getWalletAddressClassName("chain-wallet-value", walletAddress)}>
                        {walletAddress || "loading..."}
                    </code>
                </div>

                {errorMessage ? <p className="wallet-login-error">{errorMessage}</p> : null}

                <div className="chain-stats">
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Balance</span>
                        <strong className="chain-stat-value">{formatWalletAmount(wallet?.balance ?? 0)}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Transactions</span>
                        <strong className="chain-stat-value">{wallet?.transaction_count ?? 0}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Received</span>
                        <strong className="chain-stat-value">{formatWalletAmount(wallet?.total_received ?? 0)}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Sent</span>
                        <strong className="chain-stat-value">{formatWalletAmount(wallet?.total_sent ?? 0)}</strong>
                    </article>
                </div>

                <div className="chain-stats wallet-stats-grid">
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Incoming Tx</span>
                        <strong className="chain-stat-value">{wallet?.received_count ?? 0}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Outgoing Tx</span>
                        <strong className="chain-stat-value">{wallet?.sent_count ?? 0}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Fees Paid</span>
                        <strong className="chain-stat-value">{formatWalletAmount(wallet?.total_fees_paid ?? 0)}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Mined Blocks</span>
                        <strong className="chain-stat-value">{wallet?.mined_block_count ?? 0}</strong>
                    </article>
                </div>

                <article className="chain-wallet-card wallet-activity-card">
                    <span className="chain-stat-label">Latest Activity</span>
                    <strong className="wallet-activity-value">
                        {wallet?.latest_activity ? formatTimestamp(wallet.latest_activity) : "No on-chain activity yet"}
                    </strong>
                    <p className="wallet-activity-meta">
                        Showing every wallet transaction as a time-sorted ledger entry instead of full block cards.
                    </p>
                </article>

                <article className="chain-wallet-card wallet-history-card">
                    <div className="wallet-history-header">
                        <span className="chain-stat-label">Transaction History</span>
                        <span className="wallet-history-count">{wallet?.activity.length ?? 0} entries</span>
                    </div>

                    <div className="transaction-list wallet-history-list">
                        {wallet?.activity.length ? (
                            wallet.activity.map((activity, index) => (
                                <div
                                    key={`${activity.block_id ?? "no-block"}-${activity.timestamp ?? "no-time"}-${index}`}
                                    className="transaction-row wallet-history-row"
                                >
                                    <div>
                                        <span className="hash-label">{getActivityTitle(activity)}</span>
                                        <code
                                            className={getWalletAddressClassName(
                                                "hash-value",
                                                activity.kind === "sent" ? activity.receiver : activity.sender,
                                            )}
                                            title={activity.kind === "sent" ? activity.receiver : activity.sender}
                                        >
                                            {activity.kind === "mined"
                                                ? "SYSTEM -> You"
                                                : activity.kind === "sent"
                                                  ? `To: ${activity.receiver}`
                                                  : `From: ${activity.sender}`}
                                        </code>
                                    </div>
                                    <div>
                                        <span className="hash-label">Amount</span>
                                        <span className="transaction-amount">{formatActivityAmount(activity)}</span>
                                    </div>
                                    <div>
                                        <span className="hash-label">Fee</span>
                                        <span className="transaction-time">
                                            {activity.fee > 0 ? `${formatWalletAmount(activity.fee)} UNC` : "0 UNC"}
                                        </span>
                                    </div>
                                    <div>
                                        <span className="hash-label">Time</span>
                                        <span className="transaction-time">
                                            {activity.timestamp ? formatTimestamp(activity.timestamp) : "No timestamp"}
                                        </span>
                                    </div>
                                </div>
                            ))
                        ) : (
                            <p className="empty-state">No wallet transactions found yet.</p>
                        )}
                    </div>
                </article>
            </section>
        </PageScaffold>
    );
}

function StatPage() {
    const [blockchain, setBlockchain] = useState<BlockchainResponse | null>(null);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

    useEffect(() => {
        let active = true;

        const load = async () => {
            try {
                const data = await getBlockchain();
                if (active) {
                    setBlockchain(data);
                    setLastUpdated(new Date());
                }
            } catch (error) {
                console.error(error);
            }
        };

        load();
        const fetchTimer = setInterval(load, 10_000);

        return () => {
            active = false;
            clearInterval(fetchTimer);
        };
    }, []);

    const blocks = blockchain?.blocks ?? [];
    const supplySeries = buildSupplySeries(blocks);
    const latestPoint = supplySeries.length > 0 ? supplySeries[supplySeries.length - 1] : undefined;
    const firstPoint = supplySeries[0];
    const maxSupply = supplySeries.reduce((max, point) => Math.max(max, point.totalSupply), 0);
    const minTimestamp = supplySeries.reduce(
        (min, point) => Math.min(min, point.timestampMs),
        supplySeries[0]?.timestampMs ?? 0,
    );
    const maxTimestamp = supplySeries.reduce(
        (max, point) => Math.max(max, point.timestampMs),
        supplySeries[0]?.timestampMs ?? 0,
    );

    const points = supplySeries.map((point) => {
        const x =
            minTimestamp === maxTimestamp
                ? CHART_PADDING_LEFT
                : CHART_PADDING_LEFT +
                  ((point.timestampMs - minTimestamp) / (maxTimestamp - minTimestamp)) *
                      (CHART_WIDTH - CHART_PADDING_LEFT - CHART_PADDING_RIGHT);
        const y =
            maxSupply === 0
                ? CHART_HEIGHT - CHART_PADDING_BOTTOM
                : CHART_HEIGHT -
                  CHART_PADDING_BOTTOM -
                  (point.totalSupply / maxSupply) * (CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM);
        return { ...point, x, y };
    });

    const polylinePoints = points.map((point) => `${point.x},${point.y}`).join(" ");
    const xAxisY = CHART_HEIGHT - CHART_PADDING_BOTTOM;
    const yAxisX = CHART_PADDING_LEFT;
    const xAxisTicks = points.length > 0 ? buildXAxisTicks(minTimestamp, maxTimestamp) : [];
    const yAxisTicks = buildYAxisTicks(maxSupply);

    return (
        <PageScaffold>
            <PageNav
                items={[
                    { to: "/", label: "Balances" },
                    { to: "/blockchain", label: "Blockchain" },
                    { to: "/stat", label: "Stats", active: true },
                    { to: "/login", label: "Login", kind: "login" },
                ]}
            />
            <header className="masthead masthead-left">
                <p className="masthead-kicker">Stats</p>
                <h1 className="balances-title">UncCoin Supply</h1>
                <p className="masthead-subtitle">
                    Total UncCoins in existence over time, derived from blockchain timestamps and SYSTEM issuance.
                </p>
            </header>


            <section className="balances-shell" aria-label="UncCoin supply statistics">
                <div className="balances-meta">
                    <span className="balances-section-title">Supply Curve</span>
                    <p className="last-updated">
                        Last updated: {lastUpdated ? lastUpdated.toLocaleTimeString() : "loading..."}
                    </p>
                </div>

                <div className="chain-stats">
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Current Supply</span>
                        <strong className="chain-stat-value">{latestPoint?.totalSupply ?? 0}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Data Points</span>
                        <strong className="chain-stat-value">{supplySeries.length}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Start</span>
                        <strong className="chain-stat-mini">{firstPoint ? formatTimestamp(firstPoint.timestamp) : "-"}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Latest</span>
                        <strong className="chain-stat-mini">{latestPoint ? formatTimestamp(latestPoint.timestamp) : "-"}</strong>
                    </article>
                </div>

                <div className="stat-chart-card">
                    {points.length > 0 ? (
                        <>
                            <div className="stat-chart-scroll">
                                <svg
                                    className="stat-chart"
                                    viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                                    role="img"
                                    aria-label="Line chart of total UncCoins in existence over time"
                                >
                                    <defs>
                                        <clipPath id="stat-chart-clip">
                                            <rect
                                                x={CHART_PADDING_LEFT}
                                                y={CHART_PADDING_TOP}
                                                width={CHART_WIDTH - CHART_PADDING_LEFT - CHART_PADDING_RIGHT}
                                                height={CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM}
                                            />
                                        </clipPath>
                                    </defs>
                                    <line
                                        className="stat-axis"
                                        x1={yAxisX}
                                        y1={CHART_PADDING_TOP}
                                        x2={yAxisX}
                                        y2={xAxisY}
                                    />
                                    <line
                                        className="stat-axis"
                                        x1={yAxisX}
                                        y1={xAxisY}
                                        x2={CHART_WIDTH - CHART_PADDING_RIGHT}
                                        y2={xAxisY}
                                    />
                                    <line
                                        className="stat-grid"
                                        x1={yAxisX}
                                        y1={CHART_PADDING_TOP}
                                        x2={CHART_WIDTH - CHART_PADDING_RIGHT}
                                        y2={CHART_PADDING_TOP}
                                    />
                                    {yAxisTicks.map((tick) => (
                                        <line
                                            key={`y-grid-${tick.value}-${tick.y}`}
                                            className="stat-grid"
                                            x1={yAxisX}
                                            y1={tick.y}
                                            x2={CHART_WIDTH - CHART_PADDING_RIGHT}
                                            y2={tick.y}
                                        />
                                    ))}
                                    {xAxisTicks.map((tick) => (
                                        <line
                                            key={`grid-${tick.value}-${tick.x}`}
                                            className="stat-grid-vertical"
                                            x1={tick.x}
                                            y1={CHART_PADDING_TOP}
                                            x2={tick.x}
                                            y2={xAxisY}
                                        />
                                    ))}
                                    <g clipPath="url(#stat-chart-clip)">
                                        <polyline className="stat-line" points={polylinePoints} />
                                        {points.map((point, index) => (
                                            <circle
                                                key={`point-${point.timestamp}-${point.x}`}
                                                className="stat-point"
                                                cx={point.x}
                                                cy={point.y}
                                                r={index === points.length - 1 ? "4" : "2.1"}
                                            />
                                        ))}
                                    </g>
                                    {yAxisTicks.map((tick) => (
                                        <text
                                            key={`y-label-${tick.value}-${tick.y}`}
                                            className="stat-label stat-label-y"
                                            x={yAxisX - 10}
                                            y={tick.y + 4}
                                        >
                                            {tick.value}
                                        </text>
                                    ))}
                                    {xAxisTicks.map((tick, index) => (
                                        <text
                                            key={`label-${tick.value}-${tick.x}`}
                                            className={`stat-label ${
                                                index === 0
                                                    ? "stat-label-start"
                                                    : index === xAxisTicks.length - 1
                                                      ? "stat-label-end"
                                                      : "stat-label-middle"
                                            }`}
                                            x={tick.x}
                                            y={CHART_HEIGHT - 32}
                                        >
                                            <tspan x={tick.x} dy="0">
                                                {tick.dateLabel}
                                            </tspan>
                                            <tspan x={tick.x} dy="14">
                                                {tick.timeLabel}
                                            </tspan>
                                        </text>
                                    ))}
                                </svg>
                            </div>
                            <p className="stat-chart-note">
                                Supply is calculated as cumulative SYSTEM issuance minus transfers back to SYSTEM.
                            </p>
                        </>
                    ) : (
                        <p className="empty-state">No timestamped blockchain transactions available yet.</p>
                    )}
                </div>
            </section>
        </PageScaffold>
    );
}

function BlockchainPage() {
    const [blockchain, setBlockchain] = useState<BlockchainResponse | null>(null);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const [visibleBlocks, setVisibleBlocks] = useState(INITIAL_BLOCKS_VISIBLE);
    const [selectedAddress, setSelectedAddress] = useState("");
    const [showScrollTop, setShowScrollTop] = useState(false);
    const [scrollToBottomRequested, setScrollToBottomRequested] = useState(false);

    useEffect(() => {
        let active = true;

        const load = async () => {
            try {
                const data = await getBlockchain();
                if (active) {
                    setBlockchain(data);
                    setLastUpdated(new Date());
                }
            } catch (error) {
                console.error(error);
            }
        };

        load();
        const fetchTimer = setInterval(load, 10_000);

        return () => {
            active = false;
            clearInterval(fetchTimer);
        };
    }, []);

    const blocks: BlockchainBlock[] = blockchain?.blocks ?? [];
    const knownWalletAddresses = new Set(
        [
            blockchain?.wallet_address ?? "",
            ...blocks.flatMap((block) =>
                block.transactions.flatMap((transaction) => [transaction.sender, transaction.receiver]),
            ),
        ].filter((address) => address.trim().length > 0),
    );
    const recentMiningWindow = blocks.slice(-RECENT_BLOCK_STATS_WINDOW);
    const smileMinedBlocks = recentMiningWindow.filter((block) => block.description.trim() === ":)");
    const heiFrederikMinedBlocks = recentMiningWindow.filter((block) =>
        HEI_FREDERIK_PATTERN.test(block.description),
    );
    const windowsMinedBlocks = recentMiningWindow.filter((block) => WINDOWS_PATTERN.test(block.description));
    const minedWalletAddresses = recentMiningWindow
        .map((block) =>
            block.transactions.find(
                (transaction) =>
                    transaction.sender === "SYSTEM" &&
                    transaction.receiver.trim().length > 0 &&
                    transaction.receiver !== "SYSTEM" &&
                    parseAmount(transaction.amount) > 0,
            )?.receiver,
        )
        .filter((address): address is string => Boolean(address));
    const walletMinerDistribution = Object.entries(
        minedWalletAddresses.reduce<Record<string, number>>((counts, address) => {
            counts[address] = (counts[address] ?? 0) + 1;
            return counts;
        }, {}),
    ).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const addresses = Array.from(
        knownWalletAddresses,
    ).sort((left, right) => left.localeCompare(right));
    const filteredBlocks = selectedAddress
        ? blocks.filter((block) =>
              block.transactions.some(
                  (transaction) =>
                      transaction.sender === selectedAddress || transaction.receiver === selectedAddress,
              ),
          )
        : blocks;
    const sortedBlocks = [...filteredBlocks].reverse();
    const recentBlocks = sortedBlocks.slice(0, visibleBlocks);
    const latestBlock = filteredBlocks.length > 0 ? filteredBlocks[filteredBlocks.length - 1] : undefined;
    const pendingTransactions = blockchain?.pending_transactions?.length ?? 0;

    useEffect(() => {
        setVisibleBlocks((current) => {
            if (filteredBlocks.length === 0) {
                return INITIAL_BLOCKS_VISIBLE;
            }

            return Math.min(Math.max(current, INITIAL_BLOCKS_VISIBLE), filteredBlocks.length);
        });
    }, [filteredBlocks.length]);

    useEffect(() => {
        let lastScrollY = window.scrollY;

        const onScroll = () => {
            const currentScrollY = window.scrollY;
            const isScrollingUp = currentScrollY < lastScrollY;

            setShowScrollTop(isScrollingUp && currentScrollY > 320);
            lastScrollY = currentScrollY;

            const nearBottom =
                window.innerHeight + currentScrollY >= document.documentElement.scrollHeight - 300;

            if (!nearBottom) {
                return;
            }

            setVisibleBlocks((current) => {
                if (current >= sortedBlocks.length) {
                    return current;
                }

                return Math.min(current + BLOCKS_PER_BATCH, sortedBlocks.length);
            });
        };

        window.addEventListener("scroll", onScroll);
        onScroll();

        return () => {
            window.removeEventListener("scroll", onScroll);
        };
    }, [sortedBlocks.length]);

    useEffect(() => {
        if (!scrollToBottomRequested || visibleBlocks < sortedBlocks.length) {
            return;
        }

        const frame = window.requestAnimationFrame(() => {
            window.scrollTo({
                top: document.documentElement.scrollHeight,
                behavior: "smooth",
            });
            setScrollToBottomRequested(false);
        });

        return () => {
            window.cancelAnimationFrame(frame);
        };
    }, [scrollToBottomRequested, visibleBlocks, sortedBlocks.length]);

    const scrollToBottom = () => {
        setVisibleBlocks(sortedBlocks.length);
        setScrollToBottomRequested(true);
    };

    const scrollToTop = () => {
        const scroller = document.scrollingElement ?? document.documentElement ?? document.body;

        scroller.scrollTo({
            top: 0,
            behavior: "smooth",
        });

        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
    };

    return (
        <PageScaffold>
            <PageNav
                items={[
                    { to: "/", label: "Balances" },
                    { to: "/blockchain", label: "Blockchain", active: true },
                    { to: "/stat", label: "Stats" },
                    { to: "/login", label: "Login", kind: "login" },
                ]}
            />
            <header className="masthead masthead-left">
                <p className="masthead-kicker">Chain View</p>
                <h1 className="balances-title">UncCoin Blockchain</h1>
                <p className="masthead-subtitle">
                    Current chain state in a denser blockchain-only layout.
                </p>
            </header>

            <section className="balances-shell blockchain-snapshot-shell" aria-label="Recent block mining stats">
                <div className="balances-meta">
                    <span className="balances-section-title">Last {RECENT_BLOCK_STATS_WINDOW} Blocks</span>
                    <p className="last-updated">Tracking mining descriptions in the latest sample.</p>
                </div>

                <div className="chain-stats blockchain-snapshot-grid">
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Mined With ":)"</span>
                        <strong className="chain-stat-value">{formatBlockShare(smileMinedBlocks.length, recentMiningWindow.length)}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Mined With heiFrederik</span>
                        <strong className="chain-stat-value">{formatBlockShare(heiFrederikMinedBlocks.length, recentMiningWindow.length)}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Mined With windows</span>
                        <strong className="chain-stat-value">{formatBlockShare(windowsMinedBlocks.length, recentMiningWindow.length)}</strong>
                    </article>
                </div>

                <article className="chain-stat-card blockchain-distribution-card">
                    <span className="chain-stat-label">Wallet Miner Distribution</span>
                    {walletMinerDistribution.length > 0 ? (
                        <div className="blockchain-distribution-list">
                            {walletMinerDistribution.map(([address, count]) => (
                                <div key={address} className="blockchain-distribution-row">
                                    <code
                                        className={getWalletAddressClassName(
                                            "hash-value blockchain-distribution-address",
                                            address,
                                        )}
                                        title={address}
                                    >
                                        {address}
                                    </code>
                                    <span className="blockchain-distribution-share">
                                        {formatBlockShare(count, minedWalletAddresses.length)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="empty-state">No wallet miners in the latest 100 blocks.</p>
                    )}
                </article>
            </section>

            <section className="balances-shell" aria-label="UncCoin blockchain overview">
                <div className="balances-meta">
                    <span className="balances-section-title">Blockchain Overview</span>
                    <p className="last-updated">
                        Last updated: {lastUpdated ? lastUpdated.toLocaleTimeString() : "loading..."}
                    </p>
                </div>

                <div className="blockchain-toolbar">
                    <label className="blockchain-filter" htmlFor="blockchain-address-filter">
                        <span className="blockchain-filter-label">Address filter</span>
                        <select
                            id="blockchain-address-filter"
                            className="blockchain-select"
                            value={selectedAddress}
                            onChange={(event) => {
                                setSelectedAddress(event.target.value);
                                setScrollToBottomRequested(false);
                            }}
                        >
                            <option value="">All addresses</option>
                            {addresses.map((address) => (
                                <option key={address} value={address}>
                                    {address}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button
                        className="site-nav-link investment-button"
                        type="button"
                        onClick={() => {
                            setSelectedAddress("");
                            setScrollToBottomRequested(false);
                        }}
                        disabled={!selectedAddress}
                    >
                        Reset filter
                    </button>
                </div>

                <div className="chain-stats">
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Blocks</span>
                        <strong className="chain-stat-value">{filteredBlocks.length}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Latest Block</span>
                        <strong className="chain-stat-value">{latestBlock?.block_id ?? "-"}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Difficulty Bits</span>
                        <strong className="chain-stat-value">{blockchain?.difficulty_bits ?? "-"}</strong>
                    </article>
                    <article className="chain-stat-card">
                        <span className="chain-stat-label">Pending Tx</span>
                        <strong className="chain-stat-value">{pendingTransactions}</strong>
                    </article>
                </div>

                <div className="blockchain-utility-bar">
                    <button className="blockchain-utility-button" type="button" onClick={scrollToBottom}>
                        Scroll to bottom
                    </button>
                </div>

                <div className="block-list">
                    {recentBlocks.map((block) => (
                        <article key={block.block_id} className="block-card block-card-compact">
                            <div className="block-card-header">
                                <div>
                                    <p className="block-id">Block #{block.block_id}</p>
                                    <p className="block-description">{block.description || "No description"}</p>
                                </div>
                                <div className="block-card-meta">
                                    <span>{block.transactions.length} tx</span>
                                    <span>Nonce: {block.nonce}</span>
                                </div>
                            </div>

                            <div className="hash-grid hash-grid-compact">
                                <div>
                                    <span className="hash-label">Hash</span>
                                    <code className="hash-value" title={block.block_hash}>
                                        {truncateHash(block.block_hash)}
                                    </code>
                                </div>
                                <div>
                                    <span className="hash-label">Prev</span>
                                    <code className="hash-value" title={block.previous_hash}>
                                        {truncateHash(block.previous_hash)}
                                    </code>
                                </div>
                            </div>

                            <div className="transaction-list">
                                {block.transactions.length === 0 ? (
                                    <p className="empty-state">No transactions in this block.</p>
                                ) : (
                                    block.transactions.map((transaction, index) => (
                                        <div
                                            key={`${block.block_id}-${transaction.timestamp}-${index}`}
                                            className="transaction-row transaction-row-compact"
                                        >
                                            <div>
                                                <span className="hash-label">From</span>
                                                <code
                                                    className={getWalletAddressClassName(
                                                        "hash-value",
                                                        transaction.sender,
                                                    )}
                                                    title={transaction.sender}
                                                >
                                                    {transaction.sender}
                                                </code>
                                            </div>
                                            <div>
                                                <span className="hash-label">To</span>
                                                <code
                                                    className={getWalletAddressClassName(
                                                        "hash-value",
                                                        transaction.receiver,
                                                    )}
                                                    title={transaction.receiver}
                                                >
                                                    {transaction.receiver}
                                                </code>
                                            </div>
                                            <div>
                                                <span className="hash-label">Amount</span>
                                                <span className="transaction-amount">
                                                    {transaction.amount}
                                                    {transaction.fee !== "0"
                                                        ? ` (+${transaction.fee} fee)`
                                                        : ""}
                                                </span>
                                            </div>
                                            <div>
                                                <span className="hash-label">Timestamp</span>
                                                <span className="transaction-time">
                                                    {formatTimestamp(transaction.timestamp)}
                                                </span>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </article>
                    ))}
                </div>

                {sortedBlocks.length === 0 ? (
                    <p className="empty-state">No blocks match the current filter.</p>
                ) : null}

                {visibleBlocks < sortedBlocks.length ? (
                    <p className="blockchain-loading-more">Scroll down to load more blocks...</p>
                ) : null}
            </section>

            {showScrollTop ? (
                <button className="scroll-top-button" type="button" onClick={scrollToTop}>
                    Top
                </button>
            ) : null}
        </PageScaffold>
    );
}

export default function App() {
    return (
        <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/wallet" element={<WalletDashboardPage />} />
            <Route path="/blockchain" element={<BlockchainPage />} />
            <Route path="/stat" element={<StatPage />} />
        </Routes>
    );
}
