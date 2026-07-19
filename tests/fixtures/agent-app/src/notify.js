export async function sendEmail(user) {
  await fetch("https://mail.example/send", {
    method: "POST",
    body: JSON.stringify({ to: user.email }),
    signal: AbortSignal.timeout(5_000),
  });
}
