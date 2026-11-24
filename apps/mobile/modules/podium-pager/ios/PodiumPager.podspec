Pod::Spec.new do |s|
  s.name = 'PodiumPager'
  s.version = '1.0.0'
  s.summary = 'Native horizontal pager for the chat and its flight deck'
  s.description = 'A paging UIScrollView with explicit relations to the back swipe, inner scrollers and row swipe actions.'
  s.author = 'Podium'
  s.homepage = 'https://github.com/madeinorbit/podium'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.swift_version = '5.9'

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
