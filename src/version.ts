// The version of this copy, from package.json. A release's tarball carries the package.json of its tag.
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
