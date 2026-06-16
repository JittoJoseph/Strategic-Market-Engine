"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function Header() {
  const [time, setTime] = useState<Date | null>(null);
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setMounted(true);
    setTime(new Date());
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const navItems = [
    { href: "/", label: "DASHBOARD" },
    { href: "/analysis", label: "ANALYSIS" },
    { href: "/settings", label: "SETTINGS" },
  ];

  // Don't render time until after hydration to prevent mismatch
  if (!mounted || !time) {
    return (
      <header className="sticky top-0 z-50 backdrop-blur-md bg-background/80 border-b border-border/40">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold font-mono tracking-widest text-foreground">
              PENGUINX
            </h1>
            <span className="text-xs font-mono text-muted-foreground hidden sm:block">
              MARKET ENGINE
            </span>
          </div>
          <div className="text-xs font-mono text-muted-foreground tabular-nums">
            Loading...
          </div>
        </div>
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-50 backdrop-blur-md bg-background/80 border-b border-border/40">
      <div className="container mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-bold font-mono tracking-widest text-foreground">
            PENGUINX
          </h1>
          <nav className="hidden sm:flex items-center gap-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`text-[10px] font-mono tracking-wider px-2.5 py-1 rounded transition-colors ${
                  pathname === item.href
                    ? "bg-muted/40 text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="text-xs font-mono text-muted-foreground tabular-nums">
          <span className="hidden sm:inline">
            {time.toLocaleDateString("en-US", {
              weekday: "short",
              month: "short",
              day: "numeric",
            })}{" "}
          </span>
          {time.toLocaleTimeString("en-US", { hour12: false })}
        </div>
      </div>
    </header>
  );
}
