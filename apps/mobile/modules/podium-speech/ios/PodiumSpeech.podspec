Pod::Spec.new do |s|
  s.name           = 'PodiumSpeech'
  s.version        = '1.0.0'
  s.summary        = 'Private on-device dictation for Podium Mobile'
  s.description    = 'An iOS-only Expo module backed by SpeechAnalyzer and AVAudioEngine.'
  s.author         = 'Podium'
  s.homepage       = 'https://github.com/madeinorbit/podium'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'AVFAudio', 'CoreMedia', 'Speech'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
