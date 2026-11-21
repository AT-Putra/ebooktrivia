# Clauses the S&K must contain

The Owner writes the terms (S&K) and the privacy policy of each program; there is no default template.

- **Why the clauses matter.** Buyers consent to the exact published version at checkout (one consent row per page version). The
  contest and the system behave as below whatever the text says, so the text must say it.
- **Where to check.** The admin legal page editor shows this list as a short checklist.

## Contest

1. **Ranking** (Owner decision D4, US-028; plan §10 items 12 and 19). Players are ranked by:
   1. the score, higher first;
   2. the total answer time, lower first, INCLUDING the full timers of every set the player did not play (Owner decision D8), so
      skipping a set never beats playing it;
   3. the earlier finish of the last set (a player who did not finish every set ranks after those who did);
   4. the EARLIER first payment that still stands (a refunded payment does not keep its place);
   5. the player id, as a last resort, so that every rank is unique.

   The final ranking is frozen at the end of the grace period, and the Owner confirms the winners before they are announced.
2. **Timeouts and the latency grace** (plan §10 item 5).
   - A question that runs out of time scores 0 and reveals no answer.
   - An answer sent within 1.5 seconds after the timer ends still counts (the network grace). It is charged the full timer.
3. **One attempt per set.** Each set can be played once; a started set cannot be restarted.
4. **Anti-cheat data** (plan §10 item 3).
   - The IP address and a hash of the browser (user agent) are kept with every answer to detect cheating.
   - They only raise flags that the Owner reviews; nothing is decided automatically.
5. **Prizes.**
   - A winner whose payment is refunded or charged back is no longer eligible.
   - The Owner then re-awards the prize to the next eligible player of the final ranking, or reinstates the winner once the
     payment stands again (plan §10 item 17).
   - A prize already delivered is not taken back.
6. **Deadline extensions after an outage** (plan §10 item 16). The Owner may give back the time an outage took to the questions it
   cut short, at most once per answer.

## Personal data (privacy policy)

7. **Deletion = anonymization** (plan §10 item 6).
   - On request, the buyer's and player's personal data is removed: name, phone, e-mail, devices, messages and login.
   - The orders and play results stay as anonymous records, for accounting and for the fairness of the contest.
   - A person who holds a prize not delivered yet gives it up when they ask for deletion: it goes to the next eligible player.
8. **Backups.**
   - Encrypted backups are not edited; they age out within their retention window: 14 days for the continuous backups, and up to
     6 months for the monthly copies.
   - A restore never brings back data that was deleted: the deletion is applied again.
9. **What is collected and why.**
   - For the purchase and delivery: name, WhatsApp number and e-mail.
   - For the contest: the IP address and browser hash per answer.
   - For the conversion reporting to ad platforms: the click ids, and a hashed e-mail and phone for Meta and TikTok.
