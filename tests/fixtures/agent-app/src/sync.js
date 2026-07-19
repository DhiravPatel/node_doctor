import { sendEmail } from "./notify.js";

export async function syncPartners(restaurants) {
  // BUG: no-unbounded-promise-all (+ require-fetch-timeout on the inner fetch).
  await Promise.all(restaurants.map((r) => fetch(`https://partner.api/${r.id}`)));
}

export async function notifyUsers(users) {
  // BUG: no-async-array-callback — forEach does not await.
  users.forEach(async (u) => {
    await sendEmail(u);
  });
}

export async function ping() {
  // BUG: require-fetch-timeout — no signal.
  const res = await fetch("https://partner.api/ping");
  return res.ok;
}
