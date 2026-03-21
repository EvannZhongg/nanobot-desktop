/**
 * Error boundary component for catching render errors gracefully.
 * Prevents entire app crash when a single component fails.
 */
import React, { Component, type ReactNode, type ErrorInfo } from "react";

type Props = {
  children: ReactNode;
  fallbackMessage?: string;
};

type ErrorState = {
  hasError: boolean;
  error: Error | null;
};

export default class ErrorBoundary extends Component<Props, ErrorState> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary-fallback" role="alert">
          <div className="error-boundary-icon">⚠</div>
          <h3>{this.props.fallbackMessage || "Something went wrong"}</h3>
          <p className="error-boundary-detail">
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button className="error-boundary-retry" onClick={this.handleRetry}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
