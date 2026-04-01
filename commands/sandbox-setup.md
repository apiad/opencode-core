---
description: Detect project dependencies and build sandbox Docker image
agent: create
literate: true
---

We are going to build or update a custom Dockerfile image so we can run ALL tools and commands necessary for this project inside that image. This includes all general shell commands with side effects (like git, make, etc.) and all project-specific commands to run code, run tests, deploy, etc.

First, look at .opencode/sandbox/Dockerfile to understand the current Dockerfile and determine what is already installed and present a list of current dependencies.

---

Now scan the project for language runtimes and build tools:

- Language-specific toolchains like Python, Go, Node, Rust, C/C++, Java, C#, etc.
- General tools like LaTeX, Quarto, etc.
- Project-specific dependencies in makefile.
- System utilities not available by default.
- Everything else that requires some system dependencies.

Make a thorough list identifying everything that is not in the Dockerfile already. Report what must be added, updated, and removed.

---

Based on the previous list,  regenerate `.opencode/sandbox/Dockerfile` with:

- Base image (slim ubuntu image)
- System tools
- Language runtimes (Python, Node, Rust, Go) via `COPY --from=` if available
- Build tools (make, cmake, etc.)
- Any other custom dependency that must be apt-installed or curl | bash installed.

---

Finally run `docker build` to create the `opencode-{$basename}-sandbox` image.

---

Report what was detected and whether the build succeeded. Ask for further instructions if anything failed.
