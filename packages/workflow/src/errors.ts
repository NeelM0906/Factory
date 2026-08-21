export class DuplicateWorkflowHandlerError extends Error {
  constructor(name: string) {
    super(`Workflow handler ${name} is already registered.`);
    this.name = "DuplicateWorkflowHandlerError";
  }
}

export class UnknownWorkflowHandlerError extends Error {
  constructor(name: string) {
    super(`Workflow handler ${name} is not registered.`);
    this.name = "UnknownWorkflowHandlerError";
  }
}

export class RetryableJobError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryableJobError";
  }
}
