import { describe, expect, test } from "bun:test";
import type { CustomField } from "../src/lib/api.ts";
import {
  CLEAR,
  customFieldWrite,
  fieldInstant,
  formatFieldValue,
  peopleIn,
  typedFieldWrite,
} from "../src/lib/custom-fields.ts";

const field = (type: string, value: unknown, typeConfig: unknown = null): CustomField => ({
  id: "f1",
  name: "Field",
  type,
  typeConfig,
  value,
});

const ANA = { id: 42, username: "ana" };
const BEA = { id: 7, username: "bea" };

/* The menu hands back one id whatever it was opened on. Getting the body wrong
   is not visible here — it is a 400 from ClickUp seconds later, once the outbox
   drains, and by then the panel shows the value as if it took. */
describe("customFieldWrite", () => {
  test("a dropdown takes the option id on its own", () => {
    expect(customFieldWrite(field("drop_down", null), "opt-1")).toEqual({ value: "opt-1" });
    expect(customFieldWrite(field("drop_down", "opt-1"), CLEAR)).toEqual({ value: null });
  });

  test("a label field adds to the array rather than replacing it", () => {
    expect(customFieldWrite(field("labels", ["opt-1"]), "opt-2")).toEqual({
      value: ["opt-1", "opt-2"],
    });
  });

  test("picking a label that is already on takes it off", () => {
    expect(customFieldWrite(field("labels", ["opt-1", "opt-2"]), "opt-1")).toEqual({
      value: ["opt-2"],
    });
    expect(customFieldWrite(field("labels", ["opt-1"]), CLEAR)).toEqual({ value: [] });
  });

  test("a people field takes the delta upstream and the list for the mirror", () => {
    const write = customFieldWrite(field("users", [ANA]), "7", [
      { id: "7", username: "bea", initials: null, color: null, avatar: null },
    ]);
    expect(write.value).toEqual({ add: [7], rem: [] });
    expect(write.mirror).toEqual([
      ANA,
      { id: "7", username: "bea", initials: null, color: null, avatar: null },
    ]);
  });

  test("picking someone already on a people field takes them off", () => {
    const write = customFieldWrite(field("users", [ANA, BEA]), "42");
    expect(write.value).toEqual({ add: [], rem: [42] });
    expect(write.mirror).toEqual([BEA]);
  });

  test("clearing a people field removes everyone on it", () => {
    const write = customFieldWrite(field("users", [ANA, BEA]), CLEAR);
    expect(write.value).toEqual({ add: [], rem: [42, 7] });
    expect(write.mirror).toEqual([]);
  });
});

/* `<input type="number">` hands back the empty string for anything it cannot
   parse, so the component drops those before they reach this. What arrives is
   either a number it read back or a string somebody typed. */
describe("typedFieldWrite", () => {
  test("a number field goes up as a number, not as the string it was typed as", () => {
    expect(typedFieldWrite("number", "12")).toEqual({ value: 12 });
    expect(typedFieldWrite("currency", "8000.5")).toEqual({ value: 8000.5 });
  });

  test("everything else is the text as typed", () => {
    expect(typedFieldWrite("email", "ana@example.com ")).toEqual({ value: "ana@example.com" });
  });

  test("emptied is cleared", () => {
    expect(typedFieldWrite("text", "   ")).toEqual({ value: null });
    expect(typedFieldWrite("number", "")).toEqual({ value: null });
  });
});

describe("peopleIn", () => {
  test("reads the ids off the user objects", () => {
    expect(peopleIn(field("users", [{ id: 42 }, { id: "7" }]))).toEqual(["42", "7"]);
  });

  test("an unset field is nobody, and so is a shape we did not expect", () => {
    expect(peopleIn(field("users", null))).toEqual([]);
    // `Number("")` is zero, which would send a request to remove user zero.
    expect(peopleIn(field("users", [{ id: "not-a-user" }, { id: "" }, "42", null]))).toEqual([]);
  });
});

describe("fieldInstant", () => {
  test("reads milliseconds whether they arrive as digits or as a number", () => {
    expect(fieldInstant("1782000000000")).toBe(1_782_000_000_000);
    expect(fieldInstant(1_782_000_000_000)).toBe(1_782_000_000_000);
  });

  test("an unset or unreadable date is no date", () => {
    expect(fieldInstant(null)).toBeNull();
    expect(fieldInstant("")).toBeNull();
    expect(fieldInstant("whenever")).toBeNull();
  });
});

describe("formatFieldValue", () => {
  /* Clearing one of these leaves `[]`, which joins to the empty string: a row
     with no text in it and, since the text is the click target, no way back. */
  test("an emptied list reads as unset, not as blank", () => {
    expect(formatFieldValue("labels", null, [])).toBe("—");
    expect(formatFieldValue("users", null, [])).toBe("—");
  });

  test("a dropdown resolves by id and by orderindex", () => {
    const config = { options: [{ id: "opt-1", name: "Blocked", orderindex: 0 }] };
    expect(formatFieldValue("drop_down", config, "opt-1")).toBe("Blocked");
    expect(formatFieldValue("drop_down", config, 0)).toBe("Blocked");
  });

  test("people read as their usernames", () => {
    expect(formatFieldValue("users", null, [{ username: "ana" }, { username: "bea" }])).toBe(
      "ana, bea",
    );
  });

  test("a date nobody can read says so rather than 'Invalid Date'", () => {
    expect(formatFieldValue("date", null, "whenever")).toBe("—");
  });

  test("a type we cannot render says so rather than printing JSON", () => {
    expect(formatFieldValue("location", null, { lat: 1, lng: 2 })).toBe("—");
  });
});
