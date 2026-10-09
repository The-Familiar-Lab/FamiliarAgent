/** A rejection proven to occur before this message reaches a provider. */
export class AgentMessageRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentMessageRejectedError";
  }
}
