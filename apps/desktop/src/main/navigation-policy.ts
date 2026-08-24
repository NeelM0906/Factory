export interface PreventableEvent {
  preventDefault(): void;
}

export interface NavigationPolicyOptions {
  readonly productionUrl: string;
  readonly developmentOrigin?: string;
}

const numericLoopbackOrigin = (candidate: string): string | undefined => {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port.length === 0) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
};

export const createNavigationPolicy = (options: NavigationPolicyOptions) => {
  const developmentOrigin =
    options.developmentOrigin === undefined
      ? undefined
      : numericLoopbackOrigin(options.developmentOrigin);
  if (options.developmentOrigin !== undefined && developmentOrigin === undefined) {
    throw new TypeError("development renderer must use numeric loopback");
  }
  return Object.freeze({
    allowsNavigation(candidate: string): boolean {
      if (candidate === options.productionUrl) return true;
      if (developmentOrigin === undefined) return false;
      try {
        return new URL(candidate).origin === developmentOrigin;
      } catch {
        return false;
      }
    },
    permissionRequest: (): false => false,
    windowOpen: () => ({ action: "deny" as const }),
    download: (event: PreventableEvent): void => event.preventDefault(),
    navigation(candidate: string, event: PreventableEvent): void {
      if (!this.allowsNavigation(candidate)) event.preventDefault();
    }
  });
};
