Pod::Spec.new do |s|
  s.name = 'PodiumPdf'
  s.version = '1.0.0'
  s.summary = 'Native PDF artifact view'
  s.description = 'PDFKit page view with fit-to-width minimum zoom and double-tap zoom.'
  s.author = 'Podium'
  s.homepage = 'https://github.com/madeinorbit/podium'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.swift_version = '5.9'

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'PDFKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
