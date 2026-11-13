Pod::Spec.new do |s|
  s.name = 'PodiumListRow'
  s.version = '1.0.0'
  s.summary = 'Native list row press feedback and tap recognition'
  s.description = 'Keeps system Button feedback while rejecting row drags as taps.'
  s.author = 'Podium'
  s.homepage = 'https://github.com/madeinorbit/podium'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.swift_version = '5.9'

  s.dependency 'ExpoModulesCore'
  s.dependency 'ExpoUI'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
