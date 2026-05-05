# HN Daily Digest - 2026-05-05

<ContentSummary>
The X post claims Microsoft Edge stores all saved passwords in plaintext within its process memory even when those credentials are not actively used by the browser. The post provides no supporting technical evidence, reproduction steps, or version details beyond the core allegation. It merely links to an external article that contains no disclosure timeline or communication with Microsoft.
</ContentSummary>
<DiscussionSummary>
Multiple commenters argue the reported behavior aligns with Chromium’s threat model, which treats local administrator or same-user access as a game‑over scenario where no application can defend against fully privileged attackers, and note that the issue is not Edge‑specific because Firefox and most apps store credentials in plaintext without explicit user‑set master passwords or OS keychain integration. Others push back that security is not binary, citing defense‑in‑depth techniques like guard pages, Windows Credential Guard, and mobile OS separation that can limit accidental or exploit‑driven memory access to secrets. A subset of users advocate for dedicated password managers such as KeePass over browser‑based options, though many point out any password manager decrypted in the same user context will expose plaintext credentials to attackers with memory‑dumping capabilities. Disagreements also erupt over a false claim that Linux stores system passwords in plaintext in /etc, which was quickly debunked, and some dismiss the original X post as unsubstantiated hype, criticizing the researcher for sharing work on a platform that restricts thread access and redirects mobile users to download its app. Overall the conversation reflects a split between technical skepticism of the tweet’s substance and broader concerns about how password storage practices across browsers and operating systems expose secrets to memory‑dumping attacks.
</DiscussionSummary>

---

*This digest summarizes the top 20 stories from Hacker News.*