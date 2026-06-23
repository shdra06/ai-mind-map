# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x.x   | ✅ Active support |
| < 1.0   | ❌ No support |

We only provide security updates for the latest minor release of the current major version.

## Reporting a Vulnerability

**⚠️ Please do NOT open a public GitHub issue for security vulnerabilities.**

### How to Report

1. **Email**: Send a detailed report to the maintainers via [GitHub Security Advisories](https://github.com/shdra06/ai-mind-map/security/advisories/new)
2. **Include**:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Suggested fix (if you have one)

### What to Expect

| Timeline | Action |
|----------|--------|
| **24 hours** | Acknowledgment of your report |
| **72 hours** | Initial assessment and severity classification |
| **7 days** | Plan for fix or mitigation communicated |
| **30 days** | Fix released (for confirmed vulnerabilities) |

We aim to handle all reports promptly. If you don't hear back within 48 hours, please follow up.

### After the Fix

- You will be credited in the release notes (unless you prefer anonymity)
- A CVE will be requested for significant vulnerabilities
- The fix will be released as a patch version

## Scope

### In Scope

- **SQL injection** in SQLite queries
- **Path traversal** in file operations
- **Arbitrary code execution** via crafted input
- **Information disclosure** of files outside project root
- **Denial of service** through resource exhaustion
- Dependencies with known vulnerabilities (in `dependencies`, not `devDependencies`)

### Out of Scope

- Issues in third-party AI agents (Claude, Cursor, etc.)
- Vulnerabilities requiring physical access to the machine
- Social engineering attacks
- Issues in the MCP protocol itself (report to [MCP maintainers](https://github.com/modelcontextprotocol))
- Denial of service via extremely large codebases (expected behavior to be slow)

## Security Best Practices for Users

- Keep AI Mind Map updated to the latest version
- Do not expose the MCP server to untrusted networks (it uses stdio transport)
- Review `.mindmap.json` configuration in shared/public repositories
- The SQLite database (`.mindmap/mindmap.db`) may contain code snippets — treat it as sensitive

## Dependencies

We regularly audit dependencies using `npm audit`. Critical vulnerabilities in dependencies are patched or mitigated within 7 days of disclosure.
