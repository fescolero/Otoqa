import ActivityKit
import SwiftUI
import WidgetKit

/**
 * Shift Live Activity UI — lock screen card + Dynamic Island.
 *
 * The elapsed timer uses `Text(_, style: .timer)` bound to the shift
 * start Date: it ticks natively with zero updates from the app. The only
 * dynamic field is the status line (current trip/stop), updated by
 * OtoqaShiftStatusModule on shift lifecycle + check-in/out events.
 */

/// MUST stay field-for-field identical to the copy in
/// mobile/modules/otoqa-shift-status/ios/ShiftStatusAttributes.swift —
/// ActivityKit matches app ↔ extension by type name + Codable shape.
struct ShiftStatusAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var statusLine: String
  }

  var shiftStartedAt: Date
}

@main
struct ShiftStatusWidgetBundle: WidgetBundle {
  var body: some Widget {
    ShiftStatusLiveActivity()
  }
}

struct ShiftStatusLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: ShiftStatusAttributes.self) { context in
      // Lock screen / banner presentation.
      HStack(alignment: .center, spacing: 12) {
        Image(systemName: "truck.box.fill")
          .font(.title2)
          .foregroundStyle(.orange)
        VStack(alignment: .leading, spacing: 2) {
          Text("On shift")
            .font(.headline)
          Text(context.state.statusLine)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        Spacer()
        Text(context.attributes.shiftStartedAt, style: .timer)
          .font(.title2.weight(.semibold))
          .monospacedDigit()
          .frame(maxWidth: 80, alignment: .trailing)
      }
      .padding(16)
      .activityBackgroundTint(Color.black.opacity(0.6))
      .activitySystemActionForegroundColor(.orange)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Label("On shift", systemImage: "truck.box.fill")
            .font(.headline)
            .foregroundStyle(.orange)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(context.attributes.shiftStartedAt, style: .timer)
            .font(.title3.weight(.semibold))
            .monospacedDigit()
            .frame(maxWidth: 72, alignment: .trailing)
        }
        DynamicIslandExpandedRegion(.bottom) {
          Text(context.state.statusLine)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      } compactLeading: {
        Image(systemName: "truck.box.fill")
          .foregroundStyle(.orange)
      } compactTrailing: {
        Text(context.attributes.shiftStartedAt, style: .timer)
          .monospacedDigit()
          .frame(maxWidth: 48)
      } minimal: {
        Image(systemName: "truck.box.fill")
          .foregroundStyle(.orange)
      }
    }
  }
}
