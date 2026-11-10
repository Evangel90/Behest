"use client";
import { AppShell } from "@/components/chrome";
import { Notifications } from "@/components/Notifications";
import { Bracket } from "@/components/ui";

export default function NotificationsPage() {
  return (
    <AppShell>
      <div className="flex flex-col gap-3">
        <Bracket>Notifications</Bracket>
        <h1 className="text-[clamp(32px,5vw,56px)] font-medium leading-[0.95] tracking-[-0.04em]">Hear about your plans.</h1>
        <p className="max-w-[680px] text-lg leading-relaxed">Check-in reminders, release updates and arrivals, by email, Telegram or webhook.</p>
      </div>
      <Notifications />
    </AppShell>
  );
}
