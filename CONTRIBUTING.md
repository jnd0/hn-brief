# Contributing to HN-Brief

Thanks for your interest in contributing! Here's how you can help.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/hn-brief.git`
3. Install dependencies: `bun install`
4. Create a branch: `git checkout -b feature/your-feature-name`

## Development

```bash
# Run the summarizer locally
bun run summarize

# Build CSS (if modifying styles)
bun run build:css

# Serve the site
bunx serve .
```

## Pull Request Guidelines

- Keep PRs focused on a single feature or fix
- Write clear commit messages
- Test your changes locally before submitting
- Update documentation if needed

## Ideas for Contributions

- [ ] Add more LLM providers (Claude, Gemini, etc.)
- [ ] Dark mode toggle
- [ ] RSS feed generation
- [ ] Search functionality across archives
- [ ] Improve mobile responsiveness
- [ ] Add unit tests

## Code Style

- Use TypeScript for scripts
- Keep the frontend simple (vanilla HTML/CSS/JS)
- Follow existing naming conventions

## Questions?

Open an issue with the `question` label.
