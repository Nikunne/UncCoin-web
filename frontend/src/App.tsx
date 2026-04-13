import { useEffect, useState } from "react";
import { getBalances, type BalanceRow } from "./api/balances";
import "./App.css";

export default function App() {
    const [balances, setBalances] = useState<BalanceRow[]>([]);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

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
            <h1 className="balances-title">₿ Balances</h1>
            <a>Github-link for UncCoin</a>
            <a>Github-link for this repo</a>
            <p className="last-updated">
                Last updated: {lastUpdated ? lastUpdated.toLocaleTimeString() : "loading..."}
            </p>

            <div className="balances-card">
                {[...balances].reverse().map(([user, amount]) => (
                    <div key={user} className="balance-row">
                        <span className="balance-user">{user}</span>
                        <span className="balance-amount">{amount}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}