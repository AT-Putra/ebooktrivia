"use client";

import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { Button } from "@ebooktrivia/ui/components/button";

type Theme = "admin-dark" | "admin-light";
const KEY = "admin-theme";

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Dark is the default admin theme; the choice is a per-viewer convenience kept in localStorage. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("admin-dark");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(KEY);
      if (saved === "admin-light" || saved === "admin-dark") {
        setTheme(saved);
        apply(saved);
      }
    } catch {
      // storage unavailable: keep the default
    }
  }, []);

  function toggle() {
    const next: Theme = theme === "admin-dark" ? "admin-light" : "admin-dark";
    setTheme(next);
    apply(next);
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // ignore
    }
  }

  const dark = theme === "admin-dark";
  return (
    <Button variant="ghost" size="sm" onClick={toggle} aria-pressed={dark} className="min-h-9 gap-1.5">
      {dark ? <MoonIcon aria-hidden="true" size={16} weight="fill" /> : <SunIcon aria-hidden="true" size={16} weight="fill" />}
      <span>{dark ? "Dark theme" : "Light theme"}</span>
    </Button>
  );
}
