# L1 Git feature journeys

| Journey                                         | User outcome                                                     | Proof                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| [Add and restore repositories](repositories.md) | Open a working copy and keep it across restarts                  | Visible list, canonical path, unchanged files                     |
| [Browse branch history](history.md)             | Follow local and remote history without checkout                 | Branch selection, real graph, unchanged HEAD                      |
| [Inspect a commit](inspector.md)                | Read the message, parents, and changed paths                     | Merge and root details, working parent links                      |
| [Read a file diff](diff.md)                     | Read one changed file's patch in place of the history            | Unified and split diffs, binary notice, Escape back               |
| [Change appearance](appearance.md)              | Choose System, Light, or Dark without losing the repository view | Saved preference, live system changes, themed workspace and diffs |
| [Read real repository data](reader.md)          | Receive accurate repository states                               | Automated real Git and HTTP integration tests                     |

Browser and native journeys use real working copies. Reader and build checks passed for the implementation baseline. UI journeys require a live verification pass.
