"use client";

// The trivia page's account menu (US-027; the US-026 follow-up "logout everywhere"): sign out on this device
// (POST /api/v1/play/auth/logout) or end every session of the player (POST /api/v1/play/auth/logout-all), then
// back to the login page.
import { Button } from "@ebooktrivia/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@ebooktrivia/ui/components/dialog";
import { SignOutIcon, UserCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { t } from "../../../lib/t.ts";
import { postJson } from "../../play/api.ts";

export function AccountMenu() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut(path: "/api/v1/play/auth/logout" | "/api/v1/play/auth/logout-all"): Promise<void> {
    setBusy(true);
    setFailed(false);
    const answer = await postJson(path, {});
    if (answer.status === 200) {
      window.location.assign("/login");
      return;
    }
    setBusy(false);
    setFailed(true);
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full">
          <UserCircleIcon aria-hidden="true" size={32} weight="duotone" />
          <span className="sr-only">{t("trivia.account")}</span>
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={t("trivia.close")}>
        <DialogHeader>
          <DialogTitle>{t("trivia.accountMenu.title")}</DialogTitle>
          <DialogDescription>{t("trivia.accountMenu.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Button variant="outline" disabled={busy} aria-busy={busy} onClick={() => void signOut("/api/v1/play/auth/logout")}>
            <SignOutIcon aria-hidden="true" size={20} weight="bold" />
            {busy ? t("trivia.accountMenu.busy") : t("trivia.accountMenu.logout")}
          </Button>
          <Button variant="destructive" disabled={busy} aria-busy={busy} onClick={() => void signOut("/api/v1/play/auth/logout-all")}>
            <SignOutIcon aria-hidden="true" size={20} weight="bold" />
            {busy ? t("trivia.accountMenu.busy") : t("trivia.accountMenu.logoutAll")}
          </Button>
          {failed ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {t("trivia.accountMenu.failed")}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
