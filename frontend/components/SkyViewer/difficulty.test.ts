import { describe, expect, it } from "vitest";
import {
  calculateDifficulty,
  calculateObjectSurfaceBrightness,
  calculateTelescopeLimitMagnitude,
  getFallbackSkyBrightness,
} from "./difficulty";

describe("observation difficulty", () => {
  it("calculates telescope limiting magnitude from aperture in mm", () => {
    expect(calculateTelescopeLimitMagnitude(100)).toBeCloseTo(11.78, 2);
  });

  it("classifies naked-eye stars with the report threshold", () => {
    expect(
      calculateDifficulty(
        { type: "star", magnitude: 5.0, altitude: 30 },
        21.3,
        100
      )
    ).toBe(1);
  });


  it("classifies Korean star labels as point sources", () => {
    expect(
      calculateDifficulty(
        { type: "\uBCC4", magnitude: 2.0, altitude: 30 },
        14.5,
        100
      )
    ).toBe(2);
  });

  it("keeps naked-eye checks before telescope checks", () => {
    expect(
      calculateDifficulty(
        { type: "\uBCC4", magnitude: 2.0, altitude: 30 },
        17.5,
        100
      )
    ).toBe(1);
  });
  it("classifies visual telescope stars after naked-eye threshold fails", () => {
    expect(
      calculateDifficulty(
        { type: "star", magnitude: 8.5, altitude: 30 },
        21.3,
        100
      )
    ).toBe(2);
  });

  it("classifies bright extended objects as visual telescope targets", () => {
    expect(
      calculateDifficulty(
        {
          type: "open cluster",
          magnitude: 3.1,
          altitude: 30,
          majorAxisArcmin: 95,
          minorAxisArcmin: 95,
        },
        18.3,
        100
      )
    ).toBe(2);
  });

  it("classifies bright planets with the point-source magnitude rule", () => {
    expect(
      calculateDifficulty(
        { type: "planet", magnitude: -4.0, altitude: 30 },
        18.0,
        100
      )
    ).toBe(1);
  });

  it("marks non-solar targets as unobservable during daylight", () => {
    expect(
      calculateDifficulty(
        { type: "planet", magnitude: -4.0, altitude: 30, daylight: true },
        18.0,
        100
      )
    ).toBe(5);
  });

  it("does not block the Sun with the daylight rule", () => {
    expect(
      calculateDifficulty(
        {
          type: "planet",
          magnitude: -26.7,
          altitude: 30,
          daylight: true,
          daylightExempt: true,
        },
        18.0,
        100
      )
    ).toBe(1);
  });

  it("calculates deep-sky surface brightness from elliptical angular area", () => {
    expect(calculateObjectSurfaceBrightness(4, 90, 60)).toBeCloseTo(21.96, 2);
  });

  it("checks special equipment before brightness thresholds", () => {
    expect(
      calculateDifficulty(
        {
          type: "nebula",
          magnitude: 8,
          altitude: 30,
          majorAxisArcmin: 1,
          minorAxisArcmin: 1,
          emissionNebula: true,
        },
        21.3,
        100
      )
    ).toBe(4);
  });
  it("marks emission nebulae as requiring special equipment", () => {
    expect(
      calculateDifficulty(
        {
          type: "nebula",
          magnitude: 4,
          altitude: 30,
          majorAxisArcmin: 90,
          minorAxisArcmin: 60,
          emissionNebula: true,
        },
        21.3,
        100
      )
    ).toBe(4);
  });

  it("marks objects below the horizon as unobservable", () => {
    expect(
      calculateDifficulty(
        { type: "galaxy", magnitude: 8, altitude: 0, majorAxisArcmin: 10 },
        21.3,
        100
      )
    ).toBe(5);
  });

  it("falls back to brighter urban sky near Seoul", () => {
    expect(getFallbackSkyBrightness(37.5665, 126.978)).toBeCloseTo(18.0, 1);
  });
});
