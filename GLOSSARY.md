# basepad

Local environments for a project's checkouts: each gets its own services, addresses and env files, with mise as the engine.

## Language

**Environment**:
A checkout together with the databases, ports and env files that belong to it.
_Avoid_: Project (when you mean one checkout's running setup), stack, instance

**Main**:
The environment made by running `basepad up` in a checkout. Worktrees are made from it.
_Avoid_: Root, primary, parent project

**Worktree**:
An environment made from a main, in its own git worktree, with every name carrying its suffix. Say "git worktree" for git's checkout alone.
_Avoid_: Child, branch environment

**Name**:
The project's one key, set in its config. Every database and domain of its environments is built from it, and no two checkouts on a machine may be mains under the same name.
_Avoid_: Prefix, slug, project id

**Suffix**:
A worktree's own name, combined with the main's names to form the worktree's.
_Avoid_: Label, slug

**Service**:
Something basepad provides to an environment from its catalogue, such as a Postgres database.
_Avoid_: Daemon, dependency, backing service

**App**:
A process of the project's own that basepad runs and gives a domain.
_Avoid_: Daemon, server, service
