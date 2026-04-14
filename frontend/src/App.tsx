import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Route, Routes, useNavigate } from "react-router-dom";
import { getBalances, type BalanceRow } from "./api/balances";
import { getBlockchain, type BlockchainBlock, type BlockchainResponse } from "./api/blockchain";
import { getWalletSummary, loginWithWallet, type WalletSummary } from "./api/wallet";
import "./App.css";

const INITIAL_BLOCKS_VISIBLE = 25;
const BLOCKS_PER_BATCH = 25;
const CHART_WIDTH = 920;
const CHART_HEIGHT = 352;
const CHART_PADDING = 64;
const CHART_TICK_COUNT = 6;
const CHART_Y_TICK_COUNT = 5;
const WALLET_SESSION_KEY = "unc-wallet-address";
const INVESTMENT_BANNER_TEXT = ["Early investor? Click here!"];

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

function usePrevious<T>(value: T): T | undefined {
    const [previous, setPrevious] = useState<T>();

    useEffect(() => {
        setPrevious(value);
    }, [value]);

    return previous;
}

type SupplyPoint = {
    timestamp: string;
    totalSupply: number;
    label: string;
    dateLabel: string;
    timeLabel: string;
};

function buildSupplySeries(blocks: BlockchainBlock[]): SupplyPoint[] {
    let totalSupply = 0;
    const series: SupplyPoint[] = [];

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
            const dateLabel = Number.isNaN(parsed.getTime())
                ? blockTimestamp
                : parsed.toLocaleDateString();
            const timeLabel = Number.isNaN(parsed.getTime())
                ? ""
                : parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

            series.push({
                timestamp: blockTimestamp,
                totalSupply,
                label: formatTimestamp(blockTimestamp),
                dateLabel,
                timeLabel,
            });
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

function getTickIndices(length: number, desiredCount: number): number[] {
    if (length <= 0) {
        return [];
    }

    if (length <= desiredCount) {
        return Array.from({ length }, (_, index) => index);
    }

    const indices = new Set<number>();

    for (let step = 0; step < desiredCount; step += 1) {
        const index = Math.round((step / (desiredCount - 1)) * (length - 1));
        indices.add(index);
    }

    return [...indices].sort((left, right) => left - right);
}

type YAxisTick = {
    value: number;
    y: number;
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
        const y = CHART_PADDING + ratio * (CHART_HEIGHT - CHART_PADDING * 2);

        return { value, y };
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
                                className="balance-user"
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
                if (active) {
                    setWallet(data);
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
                    <code className="chain-wallet-value">{walletAddress || "loading..."}</code>
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
                        <span className="chain-stat-label">Active Blocks</span>
                        <strong className="chain-stat-value">{wallet?.block_appearance_count ?? 0}</strong>
                    </article>
                </div>

                <article className="chain-wallet-card wallet-activity-card">
                    <span className="chain-stat-label">Latest Activity</span>
                    <strong className="wallet-activity-value">
                        {wallet?.latest_activity ? formatTimestamp(wallet.latest_activity) : "No on-chain activity yet"}
                    </strong>
                    <p className="wallet-activity-meta">
                        Mined blocks: {wallet?.mined_block_count ?? 0}
                    </p>
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
    const latestPoint = supplySeries.at(-1);
    const firstPoint = supplySeries[0];
    const maxSupply = supplySeries.reduce((max, point) => Math.max(max, point.totalSupply), 0);

    const points = supplySeries.map((point, index) => {
        const x =
            supplySeries.length <= 1
                ? CHART_PADDING
                : CHART_PADDING + (index / (supplySeries.length - 1)) * (CHART_WIDTH - CHART_PADDING * 2);
        const y =
            maxSupply === 0
                ? CHART_HEIGHT - CHART_PADDING
                : CHART_HEIGHT -
                  CHART_PADDING -
                  (point.totalSupply / maxSupply) * (CHART_HEIGHT - CHART_PADDING * 2);
        return { ...point, x, y };
    });

    const polylinePoints = points.map((point) => `${point.x},${point.y}`).join(" ");
    const xAxisY = CHART_HEIGHT - CHART_PADDING;
    const yAxisX = CHART_PADDING;
    const tickIndices = getTickIndices(points.length, CHART_TICK_COUNT);
    const tickPoints = tickIndices.map((index) => points[index]).filter(Boolean);
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
                                    <line
                                        className="stat-axis"
                                        x1={yAxisX}
                                        y1={CHART_PADDING}
                                        x2={yAxisX}
                                        y2={xAxisY}
                                    />
                                    <line
                                        className="stat-axis"
                                        x1={yAxisX}
                                        y1={xAxisY}
                                        x2={CHART_WIDTH - CHART_PADDING}
                                        y2={xAxisY}
                                    />
                                    <line
                                        className="stat-grid"
                                        x1={yAxisX}
                                        y1={CHART_PADDING}
                                        x2={CHART_WIDTH - CHART_PADDING}
                                        y2={CHART_PADDING}
                                    />
                                    {yAxisTicks.map((tick) => (
                                        <line
                                            key={`y-grid-${tick.value}-${tick.y}`}
                                            className="stat-grid"
                                            x1={yAxisX}
                                            y1={tick.y}
                                            x2={CHART_WIDTH - CHART_PADDING}
                                            y2={tick.y}
                                        />
                                    ))}
                                    {tickPoints.map((point) => (
                                        <line
                                            key={`grid-${point.timestamp}-${point.x}`}
                                            className="stat-grid-vertical"
                                            x1={point.x}
                                            y1={CHART_PADDING}
                                            x2={point.x}
                                            y2={xAxisY}
                                        />
                                    ))}
                                    <polyline className="stat-line" points={polylinePoints} />
                                    {tickPoints.map((point) => (
                                        <circle
                                            key={`point-${point.timestamp}-${point.x}`}
                                            className="stat-point"
                                            cx={point.x}
                                            cy={point.y}
                                            r="3.5"
                                        />
                                    ))}
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
                                    {tickPoints.map((point, index) => (
                                        <text
                                            key={`label-${point.timestamp}-${point.x}`}
                                            className={`stat-label ${
                                                index === 0
                                                    ? ""
                                                    : index === tickPoints.length - 1
                                                      ? "stat-label-end"
                                                      : "stat-label-middle"
                                            }`}
                                            x={point.x}
                                            y={CHART_HEIGHT - 26}
                                        >
                                            <tspan x={point.x} dy="0">
                                                {point.dateLabel}
                                            </tspan>
                                            <tspan x={point.x} dy="14">
                                                {point.timeLabel}
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
    const addresses = Array.from(
        new Set(
            blocks.flatMap((block) =>
                block.transactions.flatMap((transaction) => [transaction.sender, transaction.receiver]),
            ),
        ),
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
    const latestBlock = filteredBlocks.at(-1);
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


            <section className="balances-shell" aria-label="UncCoin blockchain overview">
                <div className="balances-meta">
                    <span className="balances-section-title">Blockchain Overview</span>
                    <p className="last-updated">
                        Last updated: {lastUpdated ? lastUpdated.toLocaleTimeString() : "loading..."}
                    </p>
                </div>

                <div className="blockchain-toolbar">
                    <label className="blockchain-filter">
                        <span className="chain-stat-label">Filter by address</span>
                        <select
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
                                                <code className="hash-value" title={transaction.sender}>
                                                    {transaction.sender}
                                                </code>
                                            </div>
                                            <div>
                                                <span className="hash-label">To</span>
                                                <code className="hash-value" title={transaction.receiver}>
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
