import { describe, it, expect } from "vitest";
import {
  mapFilter,
  mapVacation,
  mapImap,
  mapPop,
  mapLanguage,
  mapSendAs,
  mapAutoForwarding,
  mapForwardingAddress,
  mapDelegate,
} from "../settings-mapper.js";

describe("mapFilter", () => {
  it("maps camelCase criteria/action to snake_case slim shape", () => {
    const result = mapFilter({
      id: "F_1",
      criteria: {
        from: "news@x.com",
        subject: "Sale",
        hasAttachment: true,
        excludeChats: true,
        negatedQuery: "unsubscribe",
        size: 1048576,
        sizeComparison: "larger",
      },
      action: {
        addLabelIds: ["Label_9"],
        removeLabelIds: ["INBOX"],
        forward: "dest@x.com",
      },
    });
    expect(result).toEqual({
      id: "F_1",
      criteria: {
        from: "news@x.com",
        subject: "Sale",
        has_attachment: true,
        exclude_chats: true,
        negated_query: "unsubscribe",
        size: 1048576,
        size_comparison: "larger",
      },
      action: {
        add_label_ids: ["Label_9"],
        remove_label_ids: ["INBOX"],
        forward: "dest@x.com",
      },
    });
  });

  it("strips upstream extras and omits absent fields", () => {
    const result = mapFilter({
      id: "F_2",
      unknownTopLevel: "drop me",
      criteria: { from: "a@b.com", surprise: 1 },
      action: { addLabelIds: ["INBOX"], mystery: true },
    });
    expect(Object.keys(result).sort()).toEqual(["action", "criteria", "id"]);
    expect(Object.keys(result.criteria)).toEqual(["from"]);
    expect(Object.keys(result.action)).toEqual(["add_label_ids"]);
  });

  it("defaults id to empty string and empty criteria/action when absent", () => {
    expect(mapFilter({})).toEqual({ id: "", criteria: {}, action: {} });
  });
});

describe("mapVacation", () => {
  it("maps all fields and defaults enable_auto_reply", () => {
    const result = mapVacation({
      enableAutoReply: true,
      responseSubject: "Away",
      responseBodyPlainText: "back monday",
      responseBodyHtml: "<p>back monday</p>",
      restrictToContacts: true,
      restrictToDomain: false,
      startTime: "1719792000000",
      endTime: "1720396800000",
      extra: "drop",
    });
    expect(result).toEqual({
      enable_auto_reply: true,
      response_subject: "Away",
      response_body_plain_text: "back monday",
      response_body_html: "<p>back monday</p>",
      restrict_to_contacts: true,
      restrict_to_domain: false,
      start_time: "1719792000000",
      end_time: "1720396800000",
    });
  });

  it("defaults enable_auto_reply to false and omits absent fields", () => {
    const result = mapVacation({});
    expect(result).toEqual({ enable_auto_reply: false });
    expect(Object.keys(result)).toEqual(["enable_auto_reply"]);
  });
});

describe("mapImap / mapPop / mapLanguage", () => {
  it("mapImap maps fields and strips extras", () => {
    const result = mapImap({
      enabled: true,
      autoExpunge: false,
      expungeBehavior: "archive",
      maxFolderSize: 5000,
      junk: 1,
    });
    expect(result).toEqual({
      enabled: true,
      auto_expunge: false,
      expunge_behavior: "archive",
      max_folder_size: 5000,
    });
  });

  it("mapImap defaults enabled and omits absent fields", () => {
    expect(mapImap({})).toEqual({ enabled: false });
  });

  it("mapPop maps fields and omits absent ones", () => {
    expect(mapPop({ accessWindow: "allMail", disposition: "leaveInInbox" })).toEqual(
      { access_window: "allMail", disposition: "leaveInInbox" },
    );
    expect(mapPop({})).toEqual({});
  });

  it("mapLanguage maps displayLanguage", () => {
    expect(mapLanguage({ displayLanguage: "en-GB", extra: 1 })).toEqual({
      display_language: "en-GB",
    });
    expect(mapLanguage({})).toEqual({ display_language: "" });
  });
});

describe("mapSendAs", () => {
  it("maps all fields to snake_case and strips extras", () => {
    const result = mapSendAs({
      sendAsEmail: "alias@x.com",
      displayName: "Alias",
      replyToAddress: "reply@x.com",
      signature: "<b>hi</b>",
      isPrimary: false,
      isDefault: true,
      treatAsAlias: true,
      verificationStatus: "accepted",
      smtpMsa: { host: "drop" },
    });
    expect(result).toEqual({
      send_as_email: "alias@x.com",
      display_name: "Alias",
      reply_to_address: "reply@x.com",
      signature: "<b>hi</b>",
      is_primary: false,
      is_default: true,
      treat_as_alias: true,
      verification_status: "accepted",
    });
  });

  it("defaults send_as_email and omits absent fields", () => {
    const result = mapSendAs({ sendAsEmail: "a@x.com" });
    expect(Object.keys(result)).toEqual(["send_as_email"]);
  });
});

describe("mapAutoForwarding", () => {
  it("maps camelCase to snake_case slim shape", () => {
    const result = mapAutoForwarding({
      enabled: true,
      emailAddress: "dest@x.com",
      disposition: "archive",
    });
    expect(result).toEqual({
      enabled: true,
      email_address: "dest@x.com",
      disposition: "archive",
    });
  });

  it("strips upstream extras and defaults enabled to false", () => {
    const result = mapAutoForwarding({ surprise: 1 });
    expect(result).toEqual({ enabled: false });
    expect(Object.keys(result)).toEqual(["enabled"]);
  });
});

describe("mapForwardingAddress", () => {
  it("maps forwardingEmail + verificationStatus", () => {
    const result = mapForwardingAddress({
      forwardingEmail: "dest@x.com",
      verificationStatus: "accepted",
    });
    expect(result).toEqual({
      forwarding_email: "dest@x.com",
      verification_status: "accepted",
    });
  });

  it("defaults forwarding_email and strips extras", () => {
    const result = mapForwardingAddress({ mystery: true });
    expect(result).toEqual({ forwarding_email: "" });
    expect(Object.keys(result)).toEqual(["forwarding_email"]);
  });
});

describe("mapDelegate", () => {
  it("maps delegateEmail + verificationStatus", () => {
    const result = mapDelegate({
      delegateEmail: "assistant@x.com",
      verificationStatus: "pending",
    });
    expect(result).toEqual({
      delegate_email: "assistant@x.com",
      verification_status: "pending",
    });
  });

  it("defaults delegate_email and strips extras", () => {
    const result = mapDelegate({ mystery: true });
    expect(result).toEqual({ delegate_email: "" });
    expect(Object.keys(result)).toEqual(["delegate_email"]);
  });
});
