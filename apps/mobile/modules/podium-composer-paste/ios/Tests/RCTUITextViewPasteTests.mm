// MANUAL FIXTURE: not compiled or run by CI. Add to an app-hosted iOS XCTest target to run.

/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <React/RCTUITextView.h>
#import <XCTest/XCTest.h>

@interface RCTUITextViewPasteTests : XCTestCase
@end

@implementation RCTUITextViewPasteTests

- (void)assertPasteWithImage:(BOOL)hasImage text:(BOOL)hasText
{
  if (!NSThread.isMainThread) {
    dispatch_sync(dispatch_get_main_queue(), ^{
      [self assertPasteWithImage:hasImage text:hasText];
    });
    return;
  }

  UIPasteboard *pasteboard = UIPasteboard.generalPasteboard;
  NSArray *previousItems = pasteboard.items;
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 320, 480)];
  window.rootViewController = [UIViewController new];
  RCTUITextView *input = [RCTUITextView new];
  input.frame = CGRectMake(0, 0, 300, 100);
  [window.rootViewController.view addSubview:input];
  [window makeKeyAndVisible];
  [input becomeFirstResponder];
  __block NSInteger imagePastes = 0;
  input.podiumImagePasteHandler = ^{
    imagePastes += 1;
  };

  @try {
    NSMutableDictionary *item = [NSMutableDictionary new];
    if (hasImage) {
      UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(2, 2)];
      UIImage *image = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
        [UIColor.redColor setFill];
        UIRectFill(CGRectMake(0, 0, 2, 2));
      }];
      item[@"public.png"] = UIImagePNGRepresentation(image);
    }
    if (hasText) {
      item[@"public.utf8-plain-text"] = @"pasted text";
    }
    pasteboard.items = @[ item ];
    input.text = @"before ";
    input.selectedRange = NSMakeRange(input.text.length, 0);

    XCTAssertTrue([input canPerformAction:@selector(paste:) withSender:nil]);
    [input paste:nil];
    XCTAssertEqual(imagePastes, hasImage ? 1 : 0);
    NSString *expected = hasText ? @"before pasted text" : @"before ";
    [self expectationForPredicate:[NSPredicate predicateWithFormat:@"text == %@", expected]
             evaluatedWithObject:input
                         handler:nil];
    [self waitForExpectationsWithTimeout:2 handler:nil];
  } @finally {
    input.podiumImagePasteHandler = nil;
    [input resignFirstResponder];
    window.hidden = YES;
    pasteboard.items = previousItems;
  }
}

- (void)testImageOnlyPasteAttachesWithoutChangingText
{
  [self assertPasteWithImage:YES text:NO];
}

- (void)testMixedPasteAttachesAndKeepsTheText
{
  [self assertPasteWithImage:YES text:YES];
}

- (void)testTextOnlyPasteKeepsTheNormalTextPath
{
  [self assertPasteWithImage:NO text:YES];
}

@end
