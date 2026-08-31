import XCTest
@testable import Speakeasy

final class CallKitReportStoreTests: XCTestCase {
  private var defaults: UserDefaults!
  private var suiteName: String!
  private var store: CallKitReportStore!

  override func setUp() {
    super.setUp()
    suiteName = "CallKitReportStoreTests.\(UUID().uuidString)"
    defaults = UserDefaults(suiteName: suiteName)
    store = CallKitReportStore(defaults: defaults)
  }

  override func tearDown() {
    UserDefaults.standard.removePersistentDomain(forName: suiteName)
    store = nil
    defaults = nil
    suiteName = nil
    super.tearDown()
  }

  func testRegistrationPersistsLatestMappingAndDisplacesSupersededUUID() {
    let firstUUID = "90a63483-79f1-4dda-b0b0-63a4ba62f642"
    let secondUUID = "f5dcb01e-2619-54b4-bfc4-9f9db17efb32"

    XCTAssertEqual(
      store.register(callId: "call-1", callUUID: firstUUID, at: 1_000),
      []
    )
    XCTAssertEqual(
      store.register(callId: "call-1", callUUID: secondUUID, at: 2_000),
      [firstUUID]
    )

    let reports = store.pending(nowMs: 2_000, maxAgeMs: 120_000)
    XCTAssertEqual(reports.count, 1)
    XCTAssertEqual(reports[0]["call_id"] as? String, "call-1")
    XCTAssertEqual(reports[0]["call_uuid"] as? String, secondUUID)
    XCTAssertEqual(reports[0]["expired"] as? Bool, false)
    XCTAssertEqual(store.pending(nowMs: 2_000, maxAgeMs: 120_000).count, 1)
    store.acknowledge(callUUID: secondUUID)
    XCTAssertTrue(store.pending(nowMs: 2_000, maxAgeMs: 120_000).isEmpty)
  }

  func testPendingReturnsStaleMappingUntilExplicitCleanupAcknowledgement() {
    let staleUUID = "90a63483-79f1-4dda-b0b0-63a4ba62f642"
    _ = store.register(callId: "call-stale", callUUID: staleUUID, at: 1_000)

    let reports = store.pending(nowMs: 121_001, maxAgeMs: 120_000)

    XCTAssertEqual(reports.count, 1)
    XCTAssertEqual(reports[0]["call_uuid"] as? String, staleUUID)
    XCTAssertEqual(reports[0]["expired"] as? Bool, true)
    XCTAssertEqual(store.pending(nowMs: 121_001, maxAgeMs: 120_000).count, 1)
    store.acknowledge(callUUID: staleUUID)
    XCTAssertTrue(store.pending(nowMs: 121_001, maxAgeMs: 120_000).isEmpty)
  }

  func testConcurrentRegistrationAndAcknowledgementPreserveNewMappings() {
    let secondStore = CallKitReportStore(defaults: defaults)
    let oldUUIDs = (0..<10).map { String(format: "00000000-0000-0000-0000-%012d", $0) }
    let newUUIDs = (10..<20).map { String(format: "00000000-0000-0000-0000-%012d", $0) }
    for (index, uuid) in oldUUIDs.enumerated() {
      _ = store.register(callId: "old-\(index)", callUUID: uuid, at: 1_000)
    }

    DispatchQueue.concurrentPerform(iterations: 20) { index in
      if index < oldUUIDs.count {
        store.acknowledge(callUUID: oldUUIDs[index])
      } else {
        let newIndex = index - oldUUIDs.count
        _ = secondStore.register(
          callId: "new-\(newIndex)",
          callUUID: newUUIDs[newIndex],
          at: 2_000
        )
      }
    }

    let pending = store.pending(nowMs: 2_000, maxAgeMs: 120_000)
    let pendingUUIDs = Set(pending.compactMap { $0["call_uuid"] as? String })
    XCTAssertEqual(pendingUUIDs, Set(newUUIDs))
  }
}
