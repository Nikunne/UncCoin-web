import { useEffect, useState } from "react";
import { getBalances, type BalanceRow } from "./api/balances";
import "./App.css";

export default function App() {
    const [balances, setBalances] = useState<BalanceRow[]>([]);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
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

        load(); // initial load
        const fetchTimer = setInterval(load, 60_000); // data refresh every minute
        const reloadTimer = setInterval(() => {
            window.location.reload();
        }, 60_000); // full page reload every minute

        return () => {
            active = false;
            clearInterval(fetchTimer);
            clearInterval(reloadTimer);
        };
    }, []);

    return (
        <div className="balances-page">
            <header className="masthead">
                <h1 className="balances-title">UncCoin</h1>
                <p className="masthead-subtitle">The most genuine cryptocurrency ever*</p>
            </header>

            <div className="investment-cta">
                <a
                    className="investment-link"
                    href="https://en.wikipedia.org/wiki/Exit_scam#Cryptocurrency_scams"
                    target="_blank"
                    rel="noreferrer"
                >
                    Interested in investing? Click-here!
                </a>
            </div>

            <section className="balances-shell" aria-label="UncCoin balances">
                <div className="balances-meta">
                    <span className="balances-section-title">Balance Sheet</span>
                    <p className="total-unc-coins">Total UncCoins: {totalUncCoins}</p>
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
                            <span className="balance-user">{user}</span>
                            <span className="balance-amount">{amount}</span>
                        </div>
                    ))}
                </div>
                <p>*Heard at Sit Hangaren, April 2026</p>
            </section>

        </div>
    );
}
