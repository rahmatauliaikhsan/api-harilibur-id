#!/usr/bin/env node
/**
 * Mengirim ringkasan refresh ke webhook bila ada masalah (error sumber resmi,
 * artikel yang ditolak, atau dataset tahun baru yang masih draft).
 *
 * Contoh:
 *   node src/scripts/alert.js refresh-report.md "$ALERT_WEBHOOK_URL"
 *
 * Notifikasi hanya dikirim bila isinya bermasalah, supaya webhook tidak spam.
 * Format yang didukung: Discord, Slack, dan Telegram (endpoint bot API).
 */

import fs from "node:fs";

const [reportPath, webhookUrl] = process.argv.slice(2);

if (!reportPath || !webhookUrl) {
  console.error("[alert] pemakaian: node src/scripts/alert.js <file-report> <webhook-url>");
  process.exitCode = 1;
} else {
  const report = fs.readFileSync(reportPath, "utf8");

  const needsAttention = [
    /Status sumber resmi: (?!berhasil)/.test(report),
    /\[rejected\]/.test(report),
    /draft \(belum resmi\)/.test(report),
    /Error sumber \(\d+/.test(report),
  ].some(Boolean);

  if (!needsAttention) {
    console.log("[alert] tidak ada masalah; notifikasi tidak dikirim.");
  } else {
    const summary = report
      .split("\n")
      .filter((line) => /rejected|Error sumber|gagal|draft|belum resmi/.test(line))
      .slice(0, 15)
      .join("\n");

    const text = `⚠️ Pemutakhiran api-harilibur-id perlu diperiksa\n\n${summary}`.slice(0, 1800);
    let payload;
    if (webhookUrl.includes("api.telegram.org")) {
      payload = { chat_id: process.env.ALERT_TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" };
    } else if (webhookUrl.includes("discord.com")) {
      payload = { content: text.slice(0, 1900) };
    } else {
      payload = { text, content: text.slice(0, 1900) };
    }

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      console.log(`[alert] webhook merespons ${response.status}`);
      if (!response.ok) console.error("[alert] body:", await response.text());
      if (response.status === 404) {
        console.error("[alert] webhook 404. Untuk Discord tambahkan ?wait=true di akhir URL.");
      }
    } catch (error) {
      // Notifikasi gagal tidak boleh menggagalkan workflow pemutakhiran data.
      console.error("[alert] gagal mengirim webhook:", error.message);
    }
  }
}
