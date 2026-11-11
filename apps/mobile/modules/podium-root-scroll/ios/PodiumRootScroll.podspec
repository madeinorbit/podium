Pod::Spec.new do |s|
  s.name = 'PodiumRootScroll'
  s.version = '1.0.0'
  s.summary = 'Root header scroll observation for iOS 16 and 17'
  s.description = 'Forwards the underlying SwiftUI List scroll position as a direct native view event.'
  s.author = 'Podium'
  s.homepage = 'https://github.com/madeinorbit/podium'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
