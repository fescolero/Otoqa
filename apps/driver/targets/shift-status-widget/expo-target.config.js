/**
 * ShiftStatusWidget — WidgetKit extension target hosting the shift Live
 * Activity UI. Generated into the Xcode project at prebuild by
 * @bacons/apple-targets; nothing here is committed to ios/ (CNG).
 *
 * deploymentTarget 16.2 = ActivityKit's ActivityContent API floor. The
 * app itself still supports lower iOS versions — the module's JS API
 * just resolves false there.
 */
/** @type {import('@bacons/apple-targets').Config} */
module.exports = {
  type: 'widget',
  name: 'ShiftStatusWidget',
  deploymentTarget: '16.2',
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit'],
};
