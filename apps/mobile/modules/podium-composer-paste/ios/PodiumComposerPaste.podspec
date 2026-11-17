Pod::Spec.new do |s|
  s.name = 'PodiumComposerPaste'
  s.version = '1.0.0'
  s.summary = 'System image paste for the chat composer'
  s.description = 'Connects an opted-in React Native text input to the existing attachment intake.'
  s.author = 'Podium'
  s.homepage = 'https://github.com/madeinorbit/podium'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.swift_version = '5.9'

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UniformTypeIdentifiers'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
