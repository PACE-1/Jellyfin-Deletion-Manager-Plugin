# Publication privacy

The public source and release packages contain synthetic test users and media. They do not contain deployment credentials, personal email addresses, private host addresses or personal home paths. Public project handles, required license contacts and GitHub no-reply identities are retained.

Run `python3 scripts/audit-publication.py .` before publication and against each release zip. The scanner checks text, printable binary strings (including UTF-16 DLL strings) and archive members for email addresses, credentials, private IP addresses and home paths. It reports locations and categories without printing detected values. CI runs these checks and their regression tests. Review screenshots visually as well; automated string scanning does not determine whether arbitrary pictures contain personal data.

When preparing a public repository from a private workspace, use a clean source export and a new Git history with a project no-reply identity. Do not publish private workspace history. `--git-history` additionally checks author and committer email metadata; it does not scan every historical file revision.

At runtime the plugin retains Jellyfin user IDs and usernames to enforce request ownership and allow administrator review. Request reasons can contain user-entered personal information. This local runtime database is not part of the public source or release packages. Shared library badges expose schedules only, without requesters or reasons. Deletion failures use a generic message rather than disclosing a filesystem path to requesters.
