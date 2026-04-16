import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Route, Routes, useNavigate } from "react-router-dom";
import { getBalances, type BalanceRow } from "./api/balances";
import { getBlockchain, type BlockchainBlock, type BlockchainResponse } from "./api/blockchain";
import {
    createBrowserWallet,
    getBonusAmount,
    getWalletSession,
    loginWithWallet,
    logoutWalletSession,
    sendWalletTransaction,
    updateBonusAmount,
    type BonusAmountSettings,
    type BrowserWallet,
    type WalletActivityItem,
    type WalletSummary,
} from "./api/wallet";
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
const MAX_SUPPLY_CHART_POINTS = 180;
const MOBILE_BREAKPOINT_PX = 700;
const MOBILE_CHART_WIDTH = 640;
const MOBILE_CHART_HEIGHT = 280;
const MOBILE_CHART_PADDING_LEFT = 56;
const MOBILE_CHART_PADDING_RIGHT = 20;
const MOBILE_CHART_PADDING_TOP = 20;
const MOBILE_CHART_PADDING_BOTTOM = 58;
const MOBILE_CHART_TICK_COUNT = 3;
const MOBILE_CHART_Y_TICK_COUNT = 4;
const MOBILE_MAX_SUPPLY_CHART_POINTS = 60;
const WALLET_SESSION_TOKEN_KEY = "unc-wallet-session-token";
const WALLET_SESSION_META_KEY = "unc-wallet-session-meta";
const BONUS_AMOUNT_STORAGE_KEY = "unc-bonus-amount";
const DEFAULT_BONUS_AMOUNT = "1";
const BONUS_RECEIVER_ADDRESS = "c5c9f38923a71ff93e03317e5afc25e66c786aea8413caea2e48dcc4ae81c7bb";
const FEATURED_WALLET_ADDRESS = "2822fb2786ef939c5350a2bb84cb200f6779c9e9ed4652f7360fd243e2d95bd1";
const SECONDARY_WALLET_ADDRESS = "fe269f427a5ad619ce480192db583a29a7ce4098b22111d9b7216e2fee6bc964";
const INVESTMENT_BANNER_TEXT = ["Early investor? Click here!"];

type StoredWalletSessionMeta = {
    wallet_address: string;
    wallet_name: string;
};

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

function collectKnownWalletAddresses(chainData: BlockchainResponse | null): string[] {
    if (!chainData) {
        return [];
    }

    const knownWalletAddresses = new Set(
        [
            chainData.wallet_address ?? "",
            ...Object.keys(chainData.wallet_names ?? {}),
            ...chainData.blocks.flatMap((block) =>
                block.transactions.flatMap((transaction) => [transaction.sender, transaction.receiver]),
            ),
        ].filter((address) => address.trim().length > 0 && address !== "SYSTEM"),
    );

    return Array.from(knownWalletAddresses).sort((left, right) => left.localeCompare(right));
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

function getWalletDisplayName(address: string, chainData: BlockchainResponse | null): string {
    const walletName = chainData?.wallet_names?.[address]?.trim();
    if (walletName) {
        return walletName;
    }

    if (!address || address === "SYSTEM") {
        return address || "Unknown";
    }

    return address;
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

function downsampleSupplySeries(series: SupplyPoint[], maxPoints: number): SupplyPoint[] {
    if (series.length <= maxPoints) {
        return series;
    }

    const sampled: SupplyPoint[] = [];
    const lastIndex = series.length - 1;

    for (let index = 0; index < maxPoints; index += 1) {
        const sourceIndex =
            index === maxPoints - 1
                ? lastIndex
                : Math.round((index / (maxPoints - 1)) * lastIndex);
        const point = series[sourceIndex];

        if (!point) {
            continue;
        }

        if (sampled[sampled.length - 1]?.timestampMs === point.timestampMs) {
            sampled[sampled.length - 1] = point;
            continue;
        }

        sampled.push(point);
    }

    return sampled;
}

function loadStoredWalletToken(): string {
    if (typeof window === "undefined") {
        return "";
    }

    return window.localStorage.getItem(WALLET_SESSION_TOKEN_KEY) ?? "";
}

function loadStoredWalletMeta(): BrowserWallet | null {
    if (typeof window === "undefined") {
        return null;
    }

    const rawValue = window.localStorage.getItem(WALLET_SESSION_META_KEY);
    if (!rawValue) {
        return null;
    }

    try {
        const parsed = JSON.parse(rawValue) as Partial<StoredWalletSessionMeta>;
        if (typeof parsed.wallet_address === "string" && typeof parsed.wallet_name === "string") {
            return {
                wallet_address: parsed.wallet_address,
                wallet_name: parsed.wallet_name,
                created_at: "",
            };
        }
    } catch (error) {
        console.error(error);
    }

    return null;
}

function persistWalletSession(token: string, browserWallet: BrowserWallet): void {
    if (typeof window === "undefined") {
        return;
    }

    window.localStorage.setItem(WALLET_SESSION_TOKEN_KEY, token);
    window.localStorage.setItem(
        WALLET_SESSION_META_KEY,
        JSON.stringify({
            wallet_address: browserWallet.wallet_address,
            wallet_name: browserWallet.wallet_name,
        } satisfies StoredWalletSessionMeta),
    );
}

function clearWalletSession(): void {
    if (typeof window === "undefined") {
        return;
    }

    window.localStorage.removeItem(WALLET_SESSION_TOKEN_KEY);
    window.localStorage.removeItem(WALLET_SESSION_META_KEY);
}

function loadStoredBonusAmount(): string {
    if (typeof window === "undefined") {
        return DEFAULT_BONUS_AMOUNT;
    }

    return window.localStorage.getItem(BONUS_AMOUNT_STORAGE_KEY) ?? DEFAULT_BONUS_AMOUNT;
}

function persistStoredBonusAmount(bonusAmount: string): void {
    if (typeof window === "undefined") {
        return;
    }

    window.localStorage.setItem(BONUS_AMOUNT_STORAGE_KEY, bonusAmount);
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

type PrimaryPage = "balances" | "blockchain" | "stats" | "wallet" | "login";

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
    const marqueeItems = [...items, ...items, ...items];
    const [isMarqueeVisible, setIsMarqueeVisible] = useState(false);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target;

            if (
                target instanceof HTMLElement &&
                (target.tagName === "INPUT" ||
                    target.tagName === "TEXTAREA" ||
                    target.tagName === "SELECT" ||
                    target.isContentEditable)
            ) {
                return;
            }

            if (event.key.toLowerCase() === "u" && !event.repeat) {
                setIsMarqueeVisible((current) => !current);
            }
        };

        window.addEventListener("keydown", onKeyDown);

        return () => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, []);

    return (
        <div className="page-nav-shell">
            {isMarqueeVisible ? (
                <div className="page-actions-marquee" aria-label="Scrolling navigation shortcuts">
                    <div className="page-actions-marquee-track">
                        {marqueeItems.map((item, index) => {
                            const className = [
                                "site-nav-link",
                                "page-actions-marquee-link",
                                item.kind === "login" ? "site-nav-link-login" : "",
                                item.active ? "site-nav-link-active" : "",
                            ]
                                .filter(Boolean)
                                .join(" ");

                            return item.to ? (
                                <Link
                                    key={`${item.label}-${item.to ?? "button"}-${index}`}
                                    className={className}
                                    to={item.to}
                                    aria-current={item.active ? "page" : undefined}
                                >
                                    {item.label}
                                </Link>
                            ) : (
                                <button
                                    key={`${item.label}-${item.to ?? "button"}-${index}`}
                                    className={`${className} investment-button`}
                                    type="button"
                                    onClick={item.onClick}
                                    disabled={item.disabled}
                                >
                                    {item.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
            ) : null}
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
        </div>
    );
}

function buildPrimaryNavItems(activePage: PrimaryPage): NavItem[] {
    const isLoggedIn = Boolean(loadStoredWalletToken());
    const walletLabel = isLoggedIn ? "My Wallet" : "Login";
    const walletTarget = isLoggedIn ? "/wallet" : "/login";

    return [
        { to: "/", label: "Balances", active: activePage === "balances" },
        { to: "/blockchain", label: "Blockchain", active: activePage === "blockchain" },
        { to: "/stat", label: "Stats", active: activePage === "stats" },
        {
            to: walletTarget,
            label: walletLabel,
            kind: "login",
            active: activePage === "wallet" || activePage === "login",
        },
    ];
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

function buildYAxisTicksForChart(maxSupply: number, chartHeight: number, paddingTop: number, paddingBottom: number, tickCount: number): YAxisTick[] {
    return Array.from({ length: tickCount }, (_, index) => {
        const ratio = tickCount === 1 ? 0 : index / (tickCount - 1);
        const value = Math.round((1 - ratio) * maxSupply);
        const y = paddingTop + ratio * (chartHeight - paddingTop - paddingBottom);

        return { value, y };
    });
}

function buildXAxisTicksForChart(
    minTimestamp: number,
    maxTimestamp: number,
    chartWidth: number,
    paddingLeft: number,
    paddingRight: number,
    tickCount: number,
): XAxisTick[] {
    if (minTimestamp === maxTimestamp) {
        const parsed = new Date(minTimestamp);

        return [
            {
                value: minTimestamp,
                x: paddingLeft,
                dateLabel: parsed.toLocaleDateString([], { day: "2-digit", month: "2-digit" }),
                timeLabel: parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            },
        ];
    }

    return Array.from({ length: tickCount }, (_, index) => {
        const ratio = tickCount === 1 ? 0 : index / (tickCount - 1);
        const value = minTimestamp + ratio * (maxTimestamp - minTimestamp);
        const parsed = new Date(value);
        const x = paddingLeft + ratio * (chartWidth - paddingLeft - paddingRight);

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
            <PageNav items={buildPrimaryNavItems("balances")} />
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
    const [walletIdentifier, setWalletIdentifier] = useState("");
    const [password, setPassword] = useState("");
    const [newWalletName, setNewWalletName] = useState("");
    const [newWalletPassword, setNewWalletPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [errorMessage, setErrorMessage] = useState("");
    const [createErrorMessage, setCreateErrorMessage] = useState("");
    const [isLoginSubmitting, setIsLoginSubmitting] = useState(false);
    const [isCreateSubmitting, setIsCreateSubmitting] = useState(false);

    useEffect(() => {
        const storedWalletToken = loadStoredWalletToken();
        if (storedWalletToken) {
            navigate("/wallet", { replace: true });
        }
    }, [navigate]);

    const onLoginSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setErrorMessage("");
        setIsLoginSubmitting(true);

        try {
            const session = await loginWithWallet(walletIdentifier.trim(), password);
            persistWalletSession(session.token, session.browser_wallet);
            navigate("/wallet");
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "Failed to log in");
        } finally {
            setIsLoginSubmitting(false);
        }
    };

    const onCreateSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setCreateErrorMessage("");

        const trimmedWalletName = newWalletName.trim();

        if (newWalletPassword !== confirmPassword) {
            setCreateErrorMessage("Passwords do not match");
            return;
        }

        if (trimmedWalletName.length < 3) {
            setCreateErrorMessage("Wallet label must be at least 3 characters");
            return;
        }

        if (newWalletPassword.length < 6) {
            setCreateErrorMessage("Password must be at least 6 characters");
            return;
        }

        setIsCreateSubmitting(true);

        try {
            const session = await createBrowserWallet(trimmedWalletName, newWalletPassword);
            persistWalletSession(session.token, session.browser_wallet);
            navigate("/wallet");
        } catch (error) {
            setCreateErrorMessage(error instanceof Error ? error.message : "Failed to create wallet");
        } finally {
            setIsCreateSubmitting(false);
        }
    };

    return (
        <PageScaffold>
            <PageNav items={buildPrimaryNavItems("login")} />
            <header className="masthead masthead-left">
                <p className="masthead-kicker">Wallet Access</p>
                <h1 className="balances-title">UncCoin Login</h1>
                <p className="masthead-subtitle">
                    Create a browser wallet with its own password, or sign in to a wallet previously created here.
                </p>
                <p className="wallet-maintainer-note wallet-maintainer-note-hero">
                    Every sent transaction also pays {loadStoredBonusAmount()} UNC to the site maintainer.
                </p>
            </header>

            <section className="wallet-auth-grid" aria-label="Wallet access">
                <article className="balances-shell login-shell">
                    <div className="wallet-auth-card-header">
                        <span className="balances-section-title">Create Browser Wallet</span>
                        <p className="wallet-auth-card-copy">
                            This creates a local wallet in `../UncCoin/` and stores its login password in this app.
                        </p>
                    </div>
                    <form className="wallet-login-form" onSubmit={onCreateSubmit}>
                        <label className="wallet-login-field">
                            <span className="chain-stat-label">Wallet label</span>
                            <input
                                className="wallet-login-input"
                                value={newWalletName}
                                onChange={(event) => {
                                    setNewWalletName(event.target.value);
                                }}
                                autoComplete="nickname"
                                placeholder="Ex: browser-unc-main"
                                minLength={3}
                                required
                            />
                        </label>
                        <label className="wallet-login-field">
                            <span className="chain-stat-label">Login password</span>
                            <input
                                className="wallet-login-input"
                                type="password"
                                value={newWalletPassword}
                                onChange={(event) => {
                                    setNewWalletPassword(event.target.value);
                                }}
                                autoComplete="new-password"
                                placeholder="Create a password"
                                minLength={6}
                                required
                            />
                        </label>
                        <label className="wallet-login-field">
                            <span className="chain-stat-label">Confirm password</span>
                            <input
                                className="wallet-login-input"
                                type="password"
                                value={confirmPassword}
                                onChange={(event) => {
                                    setConfirmPassword(event.target.value);
                                }}
                                autoComplete="new-password"
                                placeholder="Repeat the password"
                                minLength={6}
                                required
                            />
                        </label>
                        <div className="wallet-login-actions">
                            <button
                                className="investment-link investment-button"
                                type="submit"
                                disabled={isCreateSubmitting}
                            >
                                {isCreateSubmitting ? "Creating wallet..." : "Create wallet"}
                            </button>
                        </div>
                        {createErrorMessage ? <p className="wallet-login-error">{createErrorMessage}</p> : null}
                    </form>
                </article>

                <article className="balances-shell login-shell">
                    <div className="wallet-auth-card-header">
                        <span className="balances-section-title">Browser Wallet Login</span>
                        <p className="wallet-auth-card-copy">
                            Only wallets created in this browser flow can sign in here.
                        </p>
                    </div>
                    <form className="wallet-login-form" onSubmit={onLoginSubmit}>
                        <label className="wallet-login-field">
                            <span className="chain-stat-label">Wallet name or address</span>
                            <input
                                className="wallet-login-input"
                                value={walletIdentifier}
                                onChange={(event) => {
                                    setWalletIdentifier(event.target.value);
                                }}
                                autoComplete="username"
                                placeholder="Enter wallet name or address"
                                required
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
                                placeholder="Enter wallet password"
                                required
                            />
                        </label>
                        <div className="wallet-login-actions">
                            <button
                                className="investment-link investment-button"
                                type="submit"
                                disabled={isLoginSubmitting}
                            >
                                {isLoginSubmitting ? "Logging in..." : "Log in"}
                            </button>
                        </div>
                        {errorMessage ? <p className="wallet-login-error">{errorMessage}</p> : null}
                    </form>
                </article>
            </section>
        </PageScaffold>
    );
}

function WalletDashboardPage() {
    const navigate = useNavigate();
    const [walletToken, setWalletToken] = useState("");
    const [browserWallet, setBrowserWallet] = useState<BrowserWallet | null>(loadStoredWalletMeta());
    const [wallet, setWallet] = useState<WalletSummary | null>(null);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const [errorMessage, setErrorMessage] = useState("");
    const [receiverAddress, setReceiverAddress] = useState("");
    const [sendAmount, setSendAmount] = useState("");
    const [sendFee, setSendFee] = useState("0");
    const [sendStatus, setSendStatus] = useState("");
    const [isSending, setIsSending] = useState(false);
    const [receiverOptions, setReceiverOptions] = useState<string[]>([]);

    useEffect(() => {
        const storedWalletToken = loadStoredWalletToken();

        if (!storedWalletToken) {
            navigate("/login", { replace: true });
            return;
        }

        setWalletToken(storedWalletToken);
    }, [navigate]);

    useEffect(() => {
        if (!walletToken) {
            return;
        }

        let active = true;

        const load = async () => {
            try {
                const session = await getWalletSession(walletToken);
                const chainData = await getBlockchain();
                const allKnownAddresses = collectKnownWalletAddresses(chainData);
                const knownAddresses = allKnownAddresses.filter(
                    (address) => address !== session.wallet.wallet_address,
                );

                if (active) {
                    setBrowserWallet(session.browser_wallet);
                    setWallet(session.wallet);
                    setReceiverOptions(knownAddresses);
                    setLastUpdated(new Date());
                    setErrorMessage("");
                }
            } catch (error) {
                if (active) {
                    const message = error instanceof Error ? error.message : "Failed to load wallet";
                    setErrorMessage(message);
                    clearWalletSession();
                    navigate("/login", { replace: true });
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
    }, [navigate, walletToken]);

    const refreshWallet = async () => {
        if (!walletToken) {
            return;
        }

        const session = await getWalletSession(walletToken);
        const chainData = await getBlockchain();
        const allKnownAddresses = collectKnownWalletAddresses(chainData);
        setBrowserWallet(session.browser_wallet);
        setWallet(session.wallet);
        setReceiverOptions(allKnownAddresses.filter((address) => address !== session.wallet.wallet_address));
        setLastUpdated(new Date());
        setErrorMessage("");
    };

    const logOut = async () => {
        const token = walletToken || loadStoredWalletToken();
        clearWalletSession();
        if (token) {
            try {
                await logoutWalletSession(token);
            } catch (error) {
                console.error(error);
            }
        }
        navigate("/login");
    };

    const onSendSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!walletToken) {
            return;
        }

        setIsSending(true);
        setSendStatus("");
        setErrorMessage("");

        const trimmedReceiverAddress = receiverAddress.trim();
        if (!trimmedReceiverAddress) {
            setErrorMessage("Receiver address is required");
            setIsSending(false);
            return;
        }

        try {
            const response = await sendWalletTransaction(walletToken, trimmedReceiverAddress, sendAmount, sendFee);
            setBrowserWallet(response.browser_wallet);
            setWallet(response.wallet);
            setLastUpdated(new Date());
            setSendStatus("Transaction submitted. The node was started, synced, broadcasted, exported, and stopped.");
            setReceiverAddress("");
            setSendAmount("");
            setSendFee("0");
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "Failed to send transaction");
        } finally {
            setIsSending(false);
        }
    };

    return (
        <PageScaffold>
            <PageNav items={buildPrimaryNavItems("wallet")} />
            <header className="masthead masthead-left">
                <p className="masthead-kicker">Wallet Dashboard</p>
                <h1 className="balances-title">My UncCoin Wallet</h1>
                <p className="masthead-subtitle">
                    Browser-creaed wallets can send money using this interface. Be aware that the transaction time is dependant on current mining efforts.
                </p>
            </header>

            <section className="balances-shell" aria-label="Logged in wallet">
                <div className="balances-meta">
                    <span className="balances-section-title">Logged In Wallet</span>
                    <p className="last-updated">
                        Last updated: {lastUpdated ? lastUpdated.toLocaleTimeString() : "loading..."}
                    </p>
                </div>

                <div className="chain-wallet-card chain-wallet-card-header">
                    <div className="chain-wallet-card-copy">
                        <span className="chain-stat-label">Browser Wallet</span>
                        <strong className="wallet-browser-name">{browserWallet?.wallet_name ?? "loading..."}</strong>
                        <code
                            className={getWalletAddressClassName(
                                "chain-wallet-value",
                                wallet?.wallet_address ?? browserWallet?.wallet_address ?? "",
                            )}
                        >
                            {wallet?.wallet_address ?? browserWallet?.wallet_address ?? "loading..."}
                        </code>
                    </div>
                    <button className="wallet-logout-button" type="button" onClick={logOut}>
                        Log out
                    </button>
                </div>

                {errorMessage ? <p className="wallet-login-error">{errorMessage}</p> : null}
                {sendStatus ? <p className="wallet-send-success">{sendStatus}</p> : null}

                <article className="chain-wallet-card wallet-send-card">
                    <div className="wallet-history-header">
                        <span className="chain-stat-label">Send UncCoins</span>
                        <button className="wallet-refresh-button" type="button" onClick={() => void refreshWallet()}>
                            Refresh
                        </button>
                    </div>
                    <p className="wallet-maintainer-note">
                        Every sent transaction also pays {loadStoredBonusAmount()} UNC to the site maintainer.
                    </p>
                    <form className="wallet-send-form" onSubmit={onSendSubmit}>
                        <label className="wallet-login-field">
                            <span className="chain-stat-label">Receiver address</span>
                            <input
                                className="wallet-login-input"
                                value={receiverAddress}
                                onChange={(event) => {
                                    setReceiverAddress(event.target.value);
                                }}
                                placeholder="Enter receiver wallet address"
                                list="wallet-address-options"
                            />
                            <datalist id="wallet-address-options">
                                {receiverOptions.map((address) => (
                                    <option key={address} value={address} />
                                ))}
                            </datalist>
                        </label>
                        <label className="wallet-login-field">
                            <span className="chain-stat-label">Existing addresses</span>
                            <select
                                className="wallet-address-select"
                                value={receiverAddress}
                                onChange={(event) => {
                                    setReceiverAddress(event.target.value);
                                }}
                            >
                                <option value="">Select an existing address</option>
                                {receiverOptions.map((address) => (
                                    <option key={address} value={address}>
                                        {address}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <div className="wallet-send-form-row">
                            <label className="wallet-login-field">
                                <span className="chain-stat-label">Amount</span>
                                <input
                                    className="wallet-login-input"
                                    value={sendAmount}
                                    onChange={(event) => {
                                        setSendAmount(event.target.value);
                                    }}
                                    placeholder="0"
                                />
                            </label>
                            <label className="wallet-login-field">
                                <span className="chain-stat-label">Fee</span>
                                <input
                                    className="wallet-login-input"
                                    value={sendFee}
                                    onChange={(event) => {
                                        setSendFee(event.target.value);
                                    }}
                                    placeholder="0"
                                />
                            </label>
                        </div>
                        <div className="wallet-login-actions">
                            <button className="investment-link investment-button" type="submit" disabled={isSending}>
                                {isSending ? "Starting node and sending..." : "Send UncCoins"}
                            </button>
                        </div>
                    </form>
                </article>

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
                        Browser wallet created:{" "}
                        {browserWallet?.created_at ? formatTimestamp(browserWallet.created_at) : "loading..."}
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

type BonusDashboardProps = {
    bonusAmountSetting: string;
    isVisible: boolean;
    isSaving: boolean;
    errorMessage: string;
    statusMessage: string;
    onChange: (value: string) => void;
    onDismiss: () => void;
    onSave: () => void;
};

function BonusDashboard({
    bonusAmountSetting,
    isVisible,
    isSaving,
    errorMessage,
    statusMessage,
    onChange,
    onDismiss,
    onSave,
}: BonusDashboardProps) {
    if (!isVisible) {
        return null;
    }

    return (
        <div className="bonus-dashboard-overlay" role="dialog" aria-modal="true" aria-label="Maintainer fee settings">
            <div className="bonus-dashboard-backdrop" onClick={onDismiss} aria-hidden="true" />
            <div className="bonus-dashboard-panel">
                <p className="bonus-dashboard-kicker">Hidden Dashboard</p>
                <h2 className="bonus-dashboard-title">Maintainer Fee Default</h2>
                <p className="bonus-dashboard-copy">
                    This sets the default amount sent to the site maintainer on every transaction.
                </p>
                <code className="bonus-dashboard-address">{BONUS_RECEIVER_ADDRESS}</code>
                <label className="wallet-login-field" htmlFor="bonus-dashboard-input">
                    <span className="chain-stat-label">Default amount (UNC)</span>
                    <input
                        id="bonus-dashboard-input"
                        className="wallet-login-input"
                        value={bonusAmountSetting}
                        onChange={(event) => {
                            onChange(event.target.value);
                        }}
                        placeholder={DEFAULT_BONUS_AMOUNT}
                        autoFocus
                    />
                </label>
                {errorMessage ? <p className="wallet-login-error">{errorMessage}</p> : null}
                {statusMessage ? <p className="wallet-send-success">{statusMessage}</p> : null}
                <div className="bonus-dashboard-actions">
                    <button className="site-nav-link investment-button" type="button" onClick={onDismiss}>
                        Close
                    </button>
                    <button className="investment-link investment-button" type="button" onClick={onSave} disabled={isSaving}>
                        {isSaving ? "Saving..." : "Save default"}
                    </button>
                </div>
            </div>
        </div>
    );
}

function StatPage() {
    const [blockchain, setBlockchain] = useState<BlockchainResponse | null>(null);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const [isMobileChart, setIsMobileChart] = useState(() =>
        typeof window !== "undefined" ? window.innerWidth <= MOBILE_BREAKPOINT_PX : false,
    );

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

    useEffect(() => {
        const onResize = () => {
            setIsMobileChart(window.innerWidth <= MOBILE_BREAKPOINT_PX);
        };

        onResize();
        window.addEventListener("resize", onResize);

        return () => {
            window.removeEventListener("resize", onResize);
        };
    }, []);

    const blocks = blockchain?.blocks ?? [];
    const fullSupplySeries = buildSupplySeries(blocks);
    const chartWidth = isMobileChart ? MOBILE_CHART_WIDTH : CHART_WIDTH;
    const chartHeight = isMobileChart ? MOBILE_CHART_HEIGHT : CHART_HEIGHT;
    const chartPaddingLeft = isMobileChart ? MOBILE_CHART_PADDING_LEFT : CHART_PADDING_LEFT;
    const chartPaddingRight = isMobileChart ? MOBILE_CHART_PADDING_RIGHT : CHART_PADDING_RIGHT;
    const chartPaddingTop = isMobileChart ? MOBILE_CHART_PADDING_TOP : CHART_PADDING_TOP;
    const chartPaddingBottom = isMobileChart ? MOBILE_CHART_PADDING_BOTTOM : CHART_PADDING_BOTTOM;
    const chartTickCount = isMobileChart ? MOBILE_CHART_TICK_COUNT : CHART_TICK_COUNT;
    const chartYTickCount = isMobileChart ? MOBILE_CHART_Y_TICK_COUNT : CHART_Y_TICK_COUNT;
    const maxChartPoints = isMobileChart ? MOBILE_MAX_SUPPLY_CHART_POINTS : MAX_SUPPLY_CHART_POINTS;
    const supplySeries = downsampleSupplySeries(fullSupplySeries, maxChartPoints);
    const latestPoint = fullSupplySeries.length > 0 ? fullSupplySeries[fullSupplySeries.length - 1] : undefined;
    const firstPoint = fullSupplySeries[0];
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
                ? chartPaddingLeft
                : chartPaddingLeft +
                  ((point.timestampMs - minTimestamp) / (maxTimestamp - minTimestamp)) *
                      (chartWidth - chartPaddingLeft - chartPaddingRight);
        const y =
            maxSupply === 0
                ? chartHeight - chartPaddingBottom
                : chartHeight -
                  chartPaddingBottom -
                  (point.totalSupply / maxSupply) * (chartHeight - chartPaddingTop - chartPaddingBottom);
        return { ...point, x, y };
    });

    const polylinePoints = points.map((point) => `${point.x},${point.y}`).join(" ");
    const xAxisY = chartHeight - chartPaddingBottom;
    const yAxisX = chartPaddingLeft;
    const xAxisTicks =
        points.length > 0
            ? buildXAxisTicksForChart(
                  minTimestamp,
                  maxTimestamp,
                  chartWidth,
                  chartPaddingLeft,
                  chartPaddingRight,
                  chartTickCount,
              )
            : [];
    const yAxisTicks = buildYAxisTicksForChart(
        maxSupply,
        chartHeight,
        chartPaddingTop,
        chartPaddingBottom,
        chartYTickCount,
    );

    return (
        <PageScaffold>
            <PageNav items={buildPrimaryNavItems("stats")} />
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
                        <span className="chain-stat-label">Chart Points</span>
                        <strong className="chain-stat-value">
                            {supplySeries.length}
                            <span className="chain-stat-suffix"> / {fullSupplySeries.length}</span>
                        </strong>
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
                                    viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                                    role="img"
                                    aria-label="Line chart of total UncCoins in existence over time"
                                >
                                    <defs>
                                        <clipPath id="stat-chart-clip">
                                            <rect
                                                x={chartPaddingLeft}
                                                y={chartPaddingTop}
                                                width={chartWidth - chartPaddingLeft - chartPaddingRight}
                                                height={chartHeight - chartPaddingTop - chartPaddingBottom}
                                            />
                                        </clipPath>
                                    </defs>
                                    <line
                                        className="stat-axis"
                                        x1={yAxisX}
                                        y1={chartPaddingTop}
                                        x2={yAxisX}
                                        y2={xAxisY}
                                    />
                                    <line
                                        className="stat-axis"
                                        x1={yAxisX}
                                        y1={xAxisY}
                                        x2={chartWidth - chartPaddingRight}
                                        y2={xAxisY}
                                    />
                                    <line
                                        className="stat-grid"
                                        x1={yAxisX}
                                        y1={chartPaddingTop}
                                        x2={chartWidth - chartPaddingRight}
                                        y2={chartPaddingTop}
                                    />
                                    {yAxisTicks.map((tick) => (
                                        <line
                                            key={`y-grid-${tick.value}-${tick.y}`}
                                            className="stat-grid"
                                            x1={yAxisX}
                                            y1={tick.y}
                                            x2={chartWidth - chartPaddingRight}
                                            y2={tick.y}
                                        />
                                    ))}
                                    {xAxisTicks.map((tick) => (
                                        <line
                                            key={`grid-${tick.value}-${tick.x}`}
                                            className="stat-grid-vertical"
                                            x1={tick.x}
                                            y1={chartPaddingTop}
                                            x2={tick.x}
                                            y2={xAxisY}
                                        />
                                    ))}
                                    <g clipPath="url(#stat-chart-clip)">
                                        <polyline className="stat-line" points={polylinePoints} />
                                        {points.map((point, index) =>
                                            isMobileChart && index !== points.length - 1 ? null : (
                                                <circle
                                                    key={`point-${point.timestamp}-${point.x}`}
                                                    className="stat-point"
                                                    cx={point.x}
                                                    cy={point.y}
                                                    r={index === points.length - 1 ? "4" : "2.1"}
                                                />
                                            ),
                                        )}
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
                                            y={chartHeight - (isMobileChart ? 26 : 32)}
                                        >
                                            <tspan x={tick.x} dy="0">
                                                {tick.dateLabel}
                                            </tspan>
                                            {isMobileChart ? null : (
                                                <tspan x={tick.x} dy="14">
                                                    {tick.timeLabel}
                                                </tspan>
                                            )}
                                        </text>
                                    ))}
                                </svg>
                            </div>
                            <p className="stat-chart-note">
                                Supply is calculated as cumulative SYSTEM issuance minus transfers back to SYSTEM.
                                The chart samples older history to keep loading fast{isMobileChart ? " on mobile." : "."}
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
    const topMinerNames = Object.entries(
        recentMiningWindow.reduce<Record<string, number>>((counts, block) => {
            const minerName = block.description.trim();
            if (!minerName) {
                return counts;
            }

            counts[minerName] = (counts[minerName] ?? 0) + 1;
            return counts;
        }, {}),
    ).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 3);
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
    const filteredTransactionCount = filteredBlocks.reduce((count, block) => count + block.transactions.length, 0);

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
            <PageNav items={buildPrimaryNavItems("blockchain")} />
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
                    <p className="last-updated">Tracking the most active miners in the latest sample.</p>
                </div>

                <div className="chain-stats blockchain-snapshot-grid">
                    {topMinerNames.map(([minerName, count], index) => (
                        <article key={minerName} className="chain-stat-card">
                            <span className="chain-stat-label">Top Miner #{index + 1}</span>
                            <strong className="chain-stat-mini blockchain-top-miner-name" title={minerName}>
                                {minerName}
                            </strong>
                            <span className="blockchain-top-miner-share">
                                {count} blocks · {formatBlockShare(count, recentMiningWindow.length)}
                            </span>
                        </article>
                    ))}
                    {topMinerNames.length === 0
                        ? Array.from({ length: 3 }, (_, index) => (
                              <article key={`empty-miner-${index}`} className="chain-stat-card">
                                  <span className="chain-stat-label">Top Miner #{index + 1}</span>
                                  <strong className="chain-stat-mini">No miner data</strong>
                              </article>
                          ))
                        : null}
                </div>

                <article className="chain-stat-card blockchain-distribution-card">
                    <span className="chain-stat-label">Wallet Miner Distribution</span>
                    {walletMinerDistribution.length > 0 ? (
                        <div className="blockchain-distribution-list">
                            {walletMinerDistribution.map(([address, count]) => (
                                <div key={address} className="blockchain-distribution-row">
                                    <div className="blockchain-distribution-copy">
                                        {(() => {
                                            const displayName = getWalletDisplayName(address, blockchain);
                                            const showAddressSubtitle = displayName !== address;

                                            return (
                                                <>
                                        <code
                                            className={getWalletAddressClassName(
                                                "hash-value blockchain-distribution-address",
                                                address,
                                            )}
                                            title={address}
                                        >
                                            {displayName}
                                        </code>
                                                    {showAddressSubtitle ? (
                                                        <span className="blockchain-distribution-subtitle">
                                                            {address}
                                                        </span>
                                                    ) : null}
                                                </>
                                            );
                                        })()}
                                    </div>
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
                        <span className="chain-stat-label">Transactions</span>
                        <strong className="chain-stat-value">{filteredTransactionCount}</strong>
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
                                            <div className="transaction-route">
                                                <span className="hash-label">Route</span>
                                                <div className="transaction-route-values">
                                                    <code
                                                        className={getWalletAddressClassName(
                                                            "hash-value",
                                                            transaction.sender,
                                                        )}
                                                        title={transaction.sender}
                                                    >
                                                        {transaction.sender}
                                                    </code>
                                                    <span className="transaction-route-arrow" aria-hidden="true">
                                                        →
                                                    </span>
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
                                            </div>
                                            <div className="transaction-metric">
                                                <span className="hash-label">Fee</span>
                                                <span className="transaction-fee">
                                                    {transaction.sender !== "SYSTEM" && parseAmount(transaction.fee) > 0
                                                        ? transaction.fee
                                                        : ""}
                                                </span>
                                            </div>
                                            <div className="transaction-metric">
                                                <span className="hash-label">Amount</span>
                                                <span className="transaction-amount">{transaction.amount}</span>
                                            </div>
                                            <div className="transaction-metric">
                                                <span className="hash-label">Time</span>
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

function RedAlertOverlay({ onDismiss }: { onDismiss: () => void }) {
    return (
        <div className="red-alert-overlay" role="dialog" aria-modal="true" aria-label="Red alert crisis overlay">
            <div className="red-alert-backdrop" />
            <div className="red-alert-scanlines" aria-hidden="true" />
            <div className="red-alert-shell">
                <p className="red-alert-kicker">System Warning</p>
                <h2 className="red-alert-title">Red Alert</h2>
                <p className="red-alert-subtitle">
                    UncCoin emergency mode engaged. Trading floor stability compromised. Immediate caution advised.
                </p>
                <div className="red-alert-grid">
                    <article className="red-alert-card">
                        <span className="red-alert-label">Status</span>
                        <strong className="red-alert-value">Critical</strong>
                    </article>
                    <article className="red-alert-card">
                        <span className="red-alert-label">Signal</span>
                        <strong className="red-alert-value">Jammed</strong>
                    </article>
                    <article className="red-alert-card">
                        <span className="red-alert-label">Protocol</span>
                        <strong className="red-alert-value">Containment</strong>
                    </article>
                </div>
                <div className="red-alert-ticker" aria-hidden="true">
                    <span>market panic</span>
                    <span>containment protocol</span>
                    <span>volatility spike</span>
                    <span>vault lockdown</span>
                    <span>market panic</span>
                    <span>containment protocol</span>
                </div>
                <button className="red-alert-dismiss" type="button" onClick={onDismiss}>
                    Shut Down Alert
                </button>
            </div>
        </div>
    );
}

export default function App() {
    const [isRedAlertArmed, setIsRedAlertArmed] = useState(false);
    const [isRedAlertActive, setIsRedAlertActive] = useState(false);
    const [isBonusDashboardVisible, setIsBonusDashboardVisible] = useState(false);
    const [bonusAmountSetting, setBonusAmountSetting] = useState(loadStoredBonusAmount());
    const [bonusAmountDraft, setBonusAmountDraft] = useState(loadStoredBonusAmount());
    const [bonusDashboardError, setBonusDashboardError] = useState("");
    const [bonusDashboardStatus, setBonusDashboardStatus] = useState("");
    const [isBonusDashboardSaving, setIsBonusDashboardSaving] = useState(false);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target;

            if (
                target instanceof HTMLElement &&
                (target.tagName === "INPUT" ||
                    target.tagName === "TEXTAREA" ||
                    target.tagName === "SELECT" ||
                    target.isContentEditable)
            ) {
                return;
            }

            const key = event.key.toLowerCase();
            if (event.repeat) {
                return;
            }

            if (key === "h") {
                setBonusDashboardStatus("");
                setBonusDashboardError("");
                setBonusAmountDraft(bonusAmountSetting);
                setIsBonusDashboardVisible((current) => !current);
                return;
            }

            if (key === "j") {
                setIsRedAlertActive(false);
                setIsRedAlertArmed((current) => !current);
            }
        };

        window.addEventListener("keydown", onKeyDown);

        return () => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [bonusAmountSetting]);

    useEffect(() => {
        if (!isBonusDashboardVisible) {
            return;
        }

        const walletToken = loadStoredWalletToken();
        if (!walletToken) {
            setBonusDashboardError("Log in to change the maintainer fee default.");
            return;
        }

        let active = true;

        const loadSettings = async () => {
            try {
                const settings: BonusAmountSettings = await getBonusAmount(walletToken);
                if (!active) {
                    return;
                }

                setBonusAmountSetting(settings.bonus_amount);
                setBonusAmountDraft(settings.bonus_amount);
                persistStoredBonusAmount(settings.bonus_amount);
                setBonusDashboardError("");
            } catch (error) {
                if (!active) {
                    return;
                }

                setBonusDashboardError(
                    error instanceof Error ? error.message : "Failed to load the maintainer fee default",
                );
            }
        };

        void loadSettings();

        return () => {
            active = false;
        };
    }, [isBonusDashboardVisible]);

    const saveBonusAmountSetting = async () => {
        const walletToken = loadStoredWalletToken();
        if (!walletToken) {
            setBonusDashboardError("Log in to change the maintainer fee default.");
            return;
        }

        setIsBonusDashboardSaving(true);
        setBonusDashboardError("");
        setBonusDashboardStatus("");

        try {
            const settings = await updateBonusAmount(walletToken, bonusAmountDraft.trim() || DEFAULT_BONUS_AMOUNT);
            setBonusAmountSetting(settings.bonus_amount);
            setBonusAmountDraft(settings.bonus_amount);
            persistStoredBonusAmount(settings.bonus_amount);
            setBonusDashboardStatus(`Saved default maintainer fee: ${settings.bonus_amount} UNC.`);
        } catch (error) {
            setBonusDashboardError(
                error instanceof Error ? error.message : "Failed to save the maintainer fee default",
            );
        } finally {
            setIsBonusDashboardSaving(false);
        }
    };

    const startRedAlert = () => {
        setIsRedAlertActive(true);
    };

    const stopRedAlert = () => {
        setIsRedAlertActive(false);
        setIsRedAlertArmed(false);
    };

    return (
        <>
            {isRedAlertArmed ? (
                <button className="red-alert-trigger" type="button" onClick={startRedAlert}>
                    Red Alert
                </button>
            ) : null}
            {isRedAlertActive ? <RedAlertOverlay onDismiss={stopRedAlert} /> : null}
            <BonusDashboard
                bonusAmountSetting={bonusAmountDraft}
                isVisible={isBonusDashboardVisible}
                isSaving={isBonusDashboardSaving}
                errorMessage={bonusDashboardError}
                statusMessage={bonusDashboardStatus}
                onChange={setBonusAmountDraft}
                onDismiss={() => {
                    setIsBonusDashboardVisible(false);
                    setBonusDashboardError("");
                    setBonusDashboardStatus("");
                    setBonusAmountDraft(bonusAmountSetting);
                }}
                onSave={() => {
                    void saveBonusAmountSetting();
                }}
            />
            <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/wallet" element={<WalletDashboardPage />} />
                <Route path="/blockchain" element={<BlockchainPage />} />
                <Route path="/stat" element={<StatPage />} />
            </Routes>
        </>
    );
}
