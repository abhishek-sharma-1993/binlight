export type Health = { state: "checking" } | { state: "up" } | { state: "down"; reason: string };

/** Never a blank: a failed check says why it failed. */
export function describeHealth(health: Health): string {
  switch (health.state) {
    case "checking":
      return "Checking server…";
    case "up":
      return "Server is up.";
    case "down":
      return `Server unreachable: ${health.reason}`;
  }
}
