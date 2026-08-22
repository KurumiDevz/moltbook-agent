/**
 * Basic tests for the gateway and providers.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { Gateway } from "../src/gateway.js";
import { GeminiProvider } from "../src/gemini-provider.js";

describe("Gateway", () => {
  it("should create a gateway instance", () => {
    const gateway = new Gateway();
    assert(gateway instanceof Gateway);
  });

  it("should register providers", () => {
    const gateway = new Gateway();
    const provider = new GeminiProvider();
    
    gateway.registerProvider(provider);
    
    const available = gateway.getAvailableProviders();
    assert(available.includes("gemini"));
  });

  it("should return capabilities for registered provider", () => {
    const gateway = new Gateway();
    const provider = new GeminiProvider();
    
    gateway.registerProvider(provider);
    
    const caps = gateway.getProviderCapabilities("gemini");
    assert(caps);
    assert(caps.supportsImages === true);
    assert(caps.supportedModels.includes("flash"));
  });
});

describe("GeminiProvider", () => {
  it("should create a provider instance", () => {
    const provider = new GeminiProvider();
    assert(provider instanceof GeminiProvider);
    assert(provider.type === "gemini");
  });

  it("should return capabilities", () => {
    const provider = new GeminiProvider();
    const caps = provider.getCapabilities();
    
    assert(caps.supportsStreaming === false);
    assert(caps.supportsImages === true);
    assert(caps.maxTokens > 0);
  });
});