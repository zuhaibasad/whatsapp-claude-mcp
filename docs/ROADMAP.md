# Roadmap and premium ideas (not being built yet)

These are ideas held for later. Each one needs a decision from you before any work starts.

## Premium feature candidates
| Idea | What it gives | Feasibility | Risks and notes |
|---|---|---|---|
| **Voice-note transcription** | Voice notes (very common in Urdu/English chats) become text, so Claude can summarise them and create items. | High. Download audio messages only (opt-in), transcribe locally with Whisper (whisper.cpp, which handles Urdu and English), store the transcript, and delete the audio. | Needs an opt-in exception to the "no media download" rule, recorded in DECISIONS.md. Uses CPU/GPU time. Stays local. |
| **Missed / incoming call items** | "Missed call from Ali (ERP group), 2h ago" appears as an action item. | High. Baileys `call` events carry metadata only (who, when, status). | Metadata only. No audio is possible this way. |
| **Call transcription and summary** | Summaries and action items from WhatsApp calls. | **Low for personal numbers.** Baileys has no voice stack, so the bridge never hears call audio. Tools like Periskope make the call inside their own app, or use Meta's **Business Calling API**, which can record and transcribe (business API numbers only). | Needs the consent of everyone on the call in many jurisdictions. Becoming the calling client means much higher ban risk. Research item only. |
| **claude.ai (web) access** | Use wa-bridge from claude.ai in a browser, not just Desktop. | Needs a *remote* MCP endpoint: a tunnel to the local bridge with OAuth, or a cloud relay. | Breaks the "local only" rule. Exposes WhatsApp data over the internet. Needs strong authentication. Only with your explicit approval. |
| **macOS / Linux support** | Friends on Mac or Linux. | Code is mostly portable. Needs testing, plus launchd/systemd auto-start and native module builds. | Deferred: Windows first. |
